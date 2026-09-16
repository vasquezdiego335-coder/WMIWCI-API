import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { assertNoProductionCredentials, assertTestRecipient } from './_disposable-test-env'

// ════════════════════════════════════════════════════════════════════════
//  TRANSIENT READ FAILURES + SETTLEMENT CAS — behaviour, offline (2026-09-15)
//
//  THE DEFECTS THIS PINS.
//
//  1. A failed suppression-list READ (`suppression_read_failed`) was mapped to
//     the TERMINAL recipient state SUPPRESSED. Nothing was sent — the guard
//     fails closed, correctly — but the person was closed out of the campaign
//     for good, the run could finish COMPLETED, and the row was
//     indistinguishable from a real hard bounce. One database blip silently
//     removed people from a send. The same held for `context_error:` (a thrown
//     read inside the context builder), which in a real outage usually fires
//     FIRST and closed the row as CONTEXT_INVALID.
//
//  2. A recipient whose claim the sweep had re-opened could still be settled by
//     the STALE worker, overwriting the newer attempt's result — and a stale
//     attempt reached the provider at all, because ownership was never
//     re-checked before the call.
//
//  3. A guard `in_flight` refusal mapped to terminal SKIPPED. With settlement
//     now compare-and-set, the older attempt can no longer correct that row, so
//     SKIPPED would LOSE the email; it is a timed deferral instead.
//
//  HOW THIS RUNS WITH NO DATABASE. src/lib/db.ts resolves `globalThis.prisma`
//  once on first import, so an in-memory store is installed BEFORE the modules
//  under test are imported (the outbox-truthful-status.test.ts pattern). The
//  provider, renderer, context builder and queue come in through
//  CampaignDispatchDeps. `resend.emails.send` is mocked as a belt to that
//  brace: this file asserts at the end that it was never called even once.
//  The REAL race (concurrent claims, a genuinely stale settlement) runs against
//  Postgres in campaign-run-concurrency.test.ts — a fake store cannot race.
//
//  Synthetic data only; every recipient is @example.com.
// ════════════════════════════════════════════════════════════════════════

assertNoProductionCredentials()

// ── A tiny in-memory Prisma ─────────────────────────────────────────────
//  Only the operators these code paths actually use are supported; anything
//  else throws loudly rather than silently matching nothing.

type Row = Record<string, unknown>

const store: Record<string, Row[]> = {
  emailCampaignRun: [],
  emailCampaignRecipient: [],
  marketingCampaign: [],
  emailCampaignConfig: [],
  emailSend: [],
  auditLog: [],
  emailAgentSettings: [],
}

/** Deep copy that PRESERVES Date objects — JSON round-tripping would turn every
 *  timestamp into a string and quietly break the due-time comparisons. */
function clone<T>(v: T): T {
  if (v === null || v === undefined || typeof v !== 'object') return v
  if (v instanceof Date) return new Date(v.getTime()) as unknown as T
  if (Array.isArray(v)) return v.map(clone) as unknown as T
  const out: Row = {}
  for (const [k, val] of Object.entries(v as Row)) out[k] = clone(val)
  return out as unknown as T
}

const time = (v: unknown): number => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : NaN)

function matchValue(actual: unknown, cond: unknown): boolean {
  if (cond === null) return actual === null || actual === undefined
  if (cond instanceof Date) return time(actual) === cond.getTime()
  if (cond && typeof cond === 'object') {
    return Object.entries(cond as Row).every(([op, v]) => {
      switch (op) {
        case 'in':
          return (v as unknown[]).includes(actual as never)
        case 'notIn':
          return !(v as unknown[]).includes(actual as never)
        case 'not':
          return v === null ? actual !== null && actual !== undefined : !matchValue(actual, v)
        case 'equals':
          return matchValue(actual, v)
        case 'lt':
          return Number.isFinite(time(actual)) && time(actual) < time(v)
        case 'lte':
          return Number.isFinite(time(actual)) && time(actual) <= time(v)
        case 'gt':
          return Number.isFinite(time(actual)) && time(actual) > time(v)
        case 'gte':
          return Number.isFinite(time(actual)) && time(actual) >= time(v)
        default:
          throw new Error(`fake prisma: unsupported filter operator "${op}"`)
      }
    })
  }
  return actual === cond
}

function matchWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true
  return Object.entries(where).every(([field, cond]) => {
    // The sweep's due-campaign query filters through the config relation.
    if (field === 'emailConfig') {
      const inner = (cond as { is?: Row }).is
      const config = store.emailCampaignConfig.find((c) => c.campaignId === row.id)
      return !!config && matchWhere(config, inner)
    }
    return matchValue(row[field], cond)
  })
}

function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as Row)) {
      row[k] = ((row[k] as number) ?? 0) + ((v as { increment: number }).increment ?? 0)
    } else {
      row[k] = v
    }
  }
  row.updatedAt = new Date()
}

function sortRows(rows: Row[], orderBy: Row | undefined): Row[] {
  if (!orderBy) return rows
  const [field, dir] = Object.entries(orderBy)[0] as [string, string]
  return rows.slice().sort((a, b) => {
    const av = a[field]
    const bv = b[field]
    const an = av instanceof Date ? av.getTime() : (av as number | string)
    const bn = bv instanceof Date ? bv.getTime() : (bv as number | string)
    if (an === bn) return 0
    const cmp = (an as number) < (bn as number) ? -1 : 1
    return dir === 'desc' ? -cmp : cmp
  })
}

let idSeq = 0
const nextId = (p: string) => `${p}_${++idSeq}`

function delegate(model: string) {
  const rows = () => store[model]
  return {
    findUnique: async ({ where }: { where: Row }) => clone(rows().find((r) => matchWhere(r, where)) ?? null),
    findFirst: async ({ where, orderBy }: { where?: Row; orderBy?: Row }) =>
      clone(sortRows(rows().filter((r) => matchWhere(r, where)), orderBy)[0] ?? null),
    findMany: async ({ where, orderBy, take }: { where?: Row; orderBy?: Row; take?: number }) => {
      const found = sortRows(rows().filter((r) => matchWhere(r, where)), orderBy)
      return clone(take ? found.slice(0, take) : found)
    },
    count: async ({ where }: { where?: Row } = {}) => rows().filter((r) => matchWhere(r, where)).length,
    create: async ({ data }: { data: Row }) => {
      const row: Row = { id: data.id ?? nextId(model), createdAt: new Date(), updatedAt: new Date(), ...data }
      rows().push(row)
      return clone(row)
    },
    createMany: async ({ data }: { data: Row[] }) => {
      for (const d of data) rows().push({ id: nextId(model), createdAt: new Date(), updatedAt: new Date(), ...d })
      return { count: data.length }
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows().find((r) => matchWhere(r, where))
      if (!row) throw Object.assign(new Error('record not found'), { code: 'P2025' })
      applyData(row, data)
      return clone(row)
    },
    updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
      const found = rows().filter((r) => matchWhere(r, where))
      for (const r of found) applyData(r, data)
      return { count: found.length }
    },
    groupBy: async ({ by, where }: { by: string[]; where?: Row }) => {
      const buckets = new Map<string, { key: Row; n: number }>()
      for (const r of rows().filter((x) => matchWhere(x, where))) {
        const key: Row = {}
        for (const f of by) key[f] = r[f]
        const k = JSON.stringify(key)
        const b = buckets.get(k) ?? { key, n: 0 }
        b.n++
        buckets.set(k, b)
      }
      return Array.from(buckets.values()).map((b) => ({ ...b.key, _count: { _all: b.n } }))
    },
  }
}

const prismaFake = {
  $transaction: async (fn: unknown) => {
    if (typeof fn !== 'function') throw new Error('fake prisma: only interactive $transaction is used here')
    return (fn as (tx: unknown) => Promise<unknown>)(prismaFake)
  },
  $executeRaw: async () => 0,
  ...Object.fromEntries(Object.keys(store).map((m) => [m, delegate(m)])),
}
;(globalThis as unknown as { prisma: unknown }).prisma = prismaFake

// Belt AND brace: the provider object itself must never be touched.
const load = async () => {
  const { resend } = await import('../resend')
  const sendSpy = mock.method(resend.emails, 'send', async () => {
    throw new Error('a test reached the real provider')
  })
  const dispatch = await import('../email-campaign-dispatch')
  const runtime = await import('../email-automation-runtime')
  const guard = await import('../email-guard')
  return { dispatch, runtime, guard, sendSpy }
}

// ── Fixtures ────────────────────────────────────────────────────────────

const EMAIL = 'transient.recipient@example.com'
assertTestRecipient(EMAIL)

const NOW = Date.UTC(2026, 8, 15, 15, 0, 0)
const MINUTE = 60_000

type Outcome = { sent: boolean; reason?: string; retryAt?: Date; emailSendId?: string; providerId?: string; outcomeClass?: string }

type Harness = {
  runId: string
  recipientId: string
  campaignId: string
  enqueued: Array<{ name: string; data: unknown; opts: { delay?: number; jobId: string } }>
  guardCalls: number
  contextCalls: number
  deps: unknown
  recipient: () => Row
  run: () => Row
  campaign: () => Row
}

function reset(): void {
  for (const k of Object.keys(store)) store[k] = []
}

/**
 * One SENDING run with one PENDING recipient, plus injected deps whose guard
 * returns a scripted outcome. `outcomes` is consumed one per guardedSend call.
 */
function harness(opts: {
  outcomes: Outcome[]
  recipient?: Row
  runStatus?: string
  campaignStatus?: string
  contextFails?: string
  beforeGuard?: () => void
}): Harness {
  reset()
  const campaignId = nextId('camp')
  const runId = nextId('run')
  const recipientId = nextId('rec')
  store.marketingCampaign.push({ id: campaignId, name: 'Transient test', channel: 'EMAIL', sourceKey: `test_transient_${campaignId}`, status: opts.campaignStatus ?? 'ACTIVE' })
  store.emailCampaignRun.push({
    id: runId,
    campaignId,
    status: opts.runStatus ?? 'SENDING',
    snapshot: { template: 'lead-nurture-final', subject: 'Hello', sourceKey: `test_transient_${campaignId}` },
    totalRecipients: 1,
    startedAt: new Date(NOW - MINUTE),
    updatedAt: new Date(NOW - MINUTE),
  })
  store.emailCampaignRecipient.push({
    id: recipientId,
    runId,
    email: EMAIL,
    name: 'Test Person',
    customerId: null,
    leadId: null,
    bookingId: null,
    status: 'PENDING',
    reason: null,
    batchIndex: 0,
    attempts: 0,
    transientAttempts: 0,
    nextAttemptAt: null,
    emailSendId: null,
    createdAt: new Date(NOW - MINUTE),
    updatedAt: new Date(NOW - MINUTE),
    ...opts.recipient,
  })

  const h: Harness = {
    runId,
    recipientId,
    campaignId,
    enqueued: [],
    guardCalls: 0,
    contextCalls: 0,
    deps: null,
    recipient: () => store.emailCampaignRecipient.find((r) => r.id === recipientId) as Row,
    run: () => store.emailCampaignRun.find((r) => r.id === runId) as Row,
    campaign: () => store.marketingCampaign.find((c) => c.id === campaignId) as Row,
  }
  h.deps = {
    guardedSend: async () => {
      h.guardCalls++
      const next = opts.outcomes.shift()
      if (!next) throw new Error('fake guard: no scripted outcome left')
      return next
    },
    buildRecipientContext: async () => {
      h.contextCalls++
      if (opts.beforeGuard) opts.beforeGuard()
      if (opts.contextFails) return { ok: false, reason: opts.contextFails }
      return { ok: true, payload: { locale: 'en' } }
    },
    renderTemplate: async () => ({ html: '<p>x</p>', text: 'x' }),
    enqueue: async (name: string, data: unknown, o: { delay?: number; jobId: string }) => {
      h.enqueued.push({ name, data, opts: o })
      return { id: o.jobId }
    },
    now: () => NOW,
  }
  return h
}

const retryJobs = (h: Harness) => h.enqueued.filter((e) => e.name === 'campaign-recipient-retry')

// ── 1. Suppression read failure defers, it never suppresses ─────────────

test('a failed suppression read defers the recipient with backoff — never SUPPRESSED, nothing sent', async () => {
  const { dispatch, sendSpy } = await load()
  const h = harness({ outcomes: [{ sent: false, reason: 'suppression_read_failed', outcomeClass: 'retryable', emailSendId: 'es_1' }] })
  await dispatch.processCampaignBatch(h.runId, 0, h.deps as never)

  const r = h.recipient()
  assert.equal(r.status, 'DEFERRED', 'a read failure is not a verdict about this person')
  assert.notEqual(r.status, 'SUPPRESSED')
  assert.equal(r.reason, 'suppression_read_failed')
  assert.equal(r.transientAttempts, 1)
  assert.equal(time(r.nextAttemptAt), NOW + 5 * MINUTE, 'the due time is DURABLE on the row, not only in a queue job')
  assert.equal(r.emailSendId, 'es_1')
  assert.equal(sendSpy.mock.callCount(), 0, 'the provider must never be reached')

  const jobs = retryJobs(h)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].opts.delay, 5 * MINUTE)
  assert.ok(!jobs[0].opts.jobId.includes(':'), 'BullMQ rejects a custom id containing ":"')

  assert.equal(h.run().status, 'SENDING', 'a deferred recipient keeps the run open')
})

test('the row is written BEFORE the enqueue — a failed add cannot lose the recipient', async () => {
  const { dispatch } = await load()
  const h = harness({ outcomes: [{ sent: false, reason: 'suppression_read_failed', outcomeClass: 'retryable' }] })
  ;(h.deps as { enqueue: unknown }).enqueue = async () => {
    // The durable state must already be committed at this point.
    assert.equal(h.recipient().status, 'DEFERRED')
    assert.equal(time(h.recipient().nextAttemptAt), NOW + 5 * MINUTE)
    throw new Error('redis is down')
  }
  await dispatch.processCampaignBatch(h.runId, 0, h.deps as never)
  assert.equal(h.recipient().status, 'DEFERRED', 'the sweep re-drives it from nextAttemptAt')
  assert.equal(time(h.recipient().nextAttemptAt), NOW + 5 * MINUTE)
})

test('a second failure backs off further; a later successful lookup sends and clears the budget', async () => {
  const { dispatch } = await load()
  const h = harness({
    outcomes: [
      { sent: false, reason: 'suppression_read_failed', outcomeClass: 'retryable' },
      { sent: true, emailSendId: 'es_ok', providerId: 'prov_1' },
    ],
    recipient: { status: 'DEFERRED', reason: 'suppression_read_failed', transientAttempts: 1, attempts: 1, nextAttemptAt: new Date(NOW - MINUTE) },
  })
  await dispatch.processRecipientRetry(h.recipientId, h.deps as never)
  let r = h.recipient()
  assert.equal(r.status, 'DEFERRED')
  assert.equal(r.transientAttempts, 2)
  assert.equal(time(r.nextAttemptAt), NOW + 10 * MINUTE, 'exponential: 5m, then 10m')

  // The lookup recovers.
  r.nextAttemptAt = new Date(NOW - MINUTE)
  await dispatch.processRecipientRetry(h.recipientId, h.deps as never)
  r = h.recipient()
  assert.equal(r.status, 'SENT')
  assert.equal(r.nextAttemptAt, null)
  assert.equal(r.transientAttempts, 0, 'a success clears the transient budget')
  assert.equal(h.run().status, 'COMPLETED', 'the run settles once nothing is deferred')
  assert.equal(h.run().sentCount, 1)
})

test('an exhausted budget is FAILED and re-openable — never SUPPRESSED, never dropped', async () => {
  const { dispatch, guard } = await load()
  const max = (await import('../email-campaign-run')).CAMPAIGN_TRANSIENT_MAX_ATTEMPTS
  const h = harness({
    outcomes: [{ sent: false, reason: 'suppression_read_failed', outcomeClass: 'retryable', emailSendId: 'es_x' }],
    recipient: { status: 'DEFERRED', transientAttempts: max - 1, attempts: 2, nextAttemptAt: new Date(NOW - MINUTE) },
  })
  store.emailSend.push({ id: 'es_x', status: 'blocked_retryable', attempts: 0 })
  await dispatch.processRecipientRetry(h.recipientId, h.deps as never)

  const r = h.recipient()
  assert.equal(r.status, 'FAILED')
  assert.notEqual(r.status, 'SUPPRESSED')
  assert.equal(r.reason, 'suppression_read_failed:retries_exhausted')
  assert.equal(r.nextAttemptAt, null)
  assert.equal(retryJobs(h).length, 0, 'an exhausted recipient is not re-queued forever')
  assert.equal(h.run().status, 'COMPLETED_WITH_ERRORS', 'the failure is VISIBLE on the run, not hidden as a skip')
  assert.ok(guard.SENDING_STALE_MS > 0)

  // And an operator can deliberately re-open it: the ledger row is
  // blocked_retryable (a guard block never increments EmailSend.attempts), so
  // it is not one of the unknown-outcome rows the retry withholds.
  const retry = await dispatch.retryFailedRecipients(h.runId, { userId: null, name: 'test' }, h.deps as never)
  assert.equal(retry.ok, true)
  assert.equal(retry.reopened, 1)
  const reopened = h.recipient()
  assert.equal(reopened.status, 'PENDING')
  assert.equal(reopened.reason, 'manual_retry')
  assert.equal(reopened.transientAttempts, 0, 'a deliberate re-open gets a fresh budget')
  assert.equal(reopened.nextAttemptAt, null)
  assert.equal(reopened.attempts, 3, 'attempts is the claim token and is NEVER reset')
})

test('a context read that threw defers too — and never reaches the guard', async () => {
  const { dispatch } = await load()
  const h = harness({ outcomes: [], contextFails: 'context_error:connection terminated unexpectedly' })
  await dispatch.processCampaignBatch(h.runId, 0, h.deps as never)

  const r = h.recipient()
  assert.equal(r.status, 'DEFERRED', 'an outage in the context builder is not CONTEXT_INVALID')
  assert.equal(r.reason, 'context_error:connection terminated unexpectedly')
  assert.equal(r.transientAttempts, 1)
  assert.equal(time(r.nextAttemptAt), NOW + 5 * MINUTE)
  assert.equal(h.guardCalls, 0)
  assert.equal(retryJobs(h).length, 1)
})

test('a real context problem stays terminal — only failed READS are retried', async () => {
  const { dispatch } = await load()
  const h = harness({ outcomes: [], contextFails: 'context_missing:reviewUrl' })
  await dispatch.processCampaignBatch(h.runId, 0, h.deps as never)
  assert.equal(h.recipient().status, 'CONTEXT_INVALID')
  assert.equal(retryJobs(h).length, 0)
})

// ── 2. Real suppressions stay terminal ──────────────────────────────────

test('hard bounce, spam complaint and admin block remain terminal SUPPRESSED', async () => {
  const { dispatch, sendSpy } = await load()
  for (const reason of ['hard_bounce', 'spam_complaint', 'admin_block']) {
    const h = harness({ outcomes: [{ sent: false, reason, outcomeClass: 'terminal', emailSendId: 'es_b' }] })
    await dispatch.processCampaignBatch(h.runId, 0, h.deps as never)
    const r = h.recipient()
    assert.equal(r.status, 'SUPPRESSED', reason)
    assert.equal(r.reason, reason)
    assert.equal(r.nextAttemptAt, null, 'a real suppression carries no due time')
    assert.equal(retryJobs(h).length, 0, `${reason} must never be re-queued`)
    assert.equal(h.run().status, 'COMPLETED')
    // A terminal suppression is not re-openable by the operator retry either.
    const retry = await dispatch.retryFailedRecipients(h.runId, { userId: null, name: 'test' }, h.deps as never)
    assert.equal(retry.reopened, 0, `${reason} must stay closed`)
  }
  assert.equal(sendSpy.mock.callCount(), 0)
})

test('an unsubscribe stays UNSUBSCRIBED, not a retryable deferral', async () => {
  const { dispatch } = await load()
  const h = harness({ outcomes: [{ sent: false, reason: 'unsubscribed', outcomeClass: 'terminal' }] })
  await dispatch.processCampaignBatch(h.runId, 0, h.deps as never)
  assert.equal(h.recipient().status, 'UNSUBSCRIBED')
  assert.equal(retryJobs(h).length, 0)
})

// ── 3. Settlement CAS: a superseded attempt writes nothing ──────────────

test('a claim superseded during preparation never reaches the provider', async () => {
  const { dispatch, sendSpy } = await load()
  let h: Harness
  h = harness({
    outcomes: [{ sent: true, emailSendId: 'es_late' }],
    // Between the claim and the provider call, the sweep re-opens the row and a
    // newer attempt claims it — exactly the 15-minute stall the sweep exists for.
    beforeGuard: () => {
      const r = h.recipient()
      r.status = 'SENDING'
      r.attempts = (r.attempts as number) + 1
    },
  })
  await dispatch.processCampaignBatch(h.runId, 0, h.deps as never)

  assert.equal(h.guardCalls, 0, 'the stale attempt must stop BEFORE guardedSend, not merely fail to write afterwards')
  assert.equal(sendSpy.mock.callCount(), 0)
  const r = h.recipient()
  assert.equal(r.status, 'SENDING', "the newer attempt's row is untouched")
  assert.equal(r.attempts, 2)
})

test('settleRecipient refuses a stale token and writes nothing', async () => {
  const { dispatch } = await load()
  const h = harness({ outcomes: [] })
  const r = h.recipient()
  r.status = 'SENDING'
  r.attempts = 2

  assert.equal(await dispatch.settleRecipient(h.recipientId, 1, { status: 'SENT', reason: null }), false, 'an older attempt owns nothing')
  assert.equal(h.recipient().status, 'SENDING')
  assert.equal(await dispatch.settleRecipient(h.recipientId, 2, { status: 'SENT', reason: null }), true)
  assert.equal(h.recipient().status, 'SENT')
  // Once settled, the same token cannot re-open the row (status moved).
  assert.equal(await dispatch.settleRecipient(h.recipientId, 2, { status: 'PENDING', reason: 'run_not_sendable' }), false)
  assert.equal(h.recipient().status, 'SENT')
})

// ── 4. in_flight is a timed retry, never a terminal skip ────────────────

test("a guard 'in_flight' refusal defers past the guard's stale window instead of losing the email", async () => {
  const { dispatch, guard } = await load()
  const h = harness({ outcomes: [{ sent: false, reason: 'in_flight', outcomeClass: 'retryable', emailSendId: 'es_live' }] })
  await dispatch.processCampaignBatch(h.runId, 0, h.deps as never)

  const r = h.recipient()
  assert.equal(r.status, 'DEFERRED', 'SKIPPED would close the row while the other attempt may still fail')
  assert.notEqual(r.status, 'SKIPPED')
  assert.equal(r.reason, 'in_flight')
  assert.equal(time(r.nextAttemptAt), NOW + guard.SENDING_STALE_MS + 60_000, 'it must wait past the window that frees the send claim')
  const jobs = retryJobs(h)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].opts.delay, guard.SENDING_STALE_MS + 60_000)
  assert.ok(!jobs[0].opts.jobId.includes(':'))
})

// ── 5. Pause, due-time and cancel ───────────────────────────────────────

test('a retry job held by the kill switch leaves the row exactly as it was', async () => {
  const { dispatch } = await load()
  const h = harness({
    outcomes: [],
    recipient: { status: 'DEFERRED', reason: 'suppression_read_failed', transientAttempts: 1, attempts: 1, nextAttemptAt: new Date(NOW - MINUTE) },
  })
  store.emailAgentSettings.push({ id: 'singleton', marketingDispatchPaused: true, pausedReason: 'incident', pausedAt: new Date(NOW), pausedBy: 'owner' })
  await dispatch.processRecipientRetry(h.recipientId, h.deps as never)

  const r = h.recipient()
  assert.equal(h.guardCalls, 0, 'the kill switch must stop work already in flight, not just new dispatches')
  assert.equal(r.status, 'DEFERRED')
  assert.equal(r.attempts, 1, 'no claim was made, so the token did not move')
  assert.equal(time(r.nextAttemptAt), NOW - MINUTE, 'the due time survives the pause')
})

test('a retry job that fires early does not claim the row', async () => {
  const { dispatch } = await load()
  const h = harness({
    outcomes: [],
    recipient: { status: 'DEFERRED', transientAttempts: 1, attempts: 1, nextAttemptAt: new Date(NOW + 30 * MINUTE) },
  })
  await dispatch.processRecipientRetry(h.recipientId, h.deps as never)
  assert.equal(h.guardCalls, 0)
  assert.equal(h.recipient().attempts, 1)
  assert.equal(h.recipient().status, 'DEFERRED')
})

test('cancelling a run closes transient deferrals and clears their due time', async () => {
  const { dispatch } = await load()
  const h = harness({
    outcomes: [],
    recipient: { status: 'DEFERRED', reason: 'suppression_read_failed', transientAttempts: 2, attempts: 1, nextAttemptAt: new Date(NOW + MINUTE) },
  })
  const out = await dispatch.cancelRun(h.runId, { userId: null, name: 'owner' })
  assert.equal(out.ok, true)
  const r = h.recipient()
  assert.equal(r.status, 'CANCELLED')
  assert.equal(r.reason, 'run_cancelled')
  assert.equal(r.nextAttemptAt, null, 'a cancelled recipient must not keep a due time the sweep could act on')
  assert.equal(h.run().status, 'CANCELLED')
})

// ── 6. The sweep is the durable recovery ────────────────────────────────

async function sweepHarness(rows: Array<Partial<Row> & { runStatus: string }>) {
  reset()
  const campaignId = nextId('camp')
  store.marketingCampaign.push({ id: campaignId, channel: 'EMAIL', status: 'ACTIVE', sourceKey: `test_sweep_${campaignId}` })
  const enqueued: Array<{ name: string; opts: { jobId: string; delay?: number } }> = []
  const ids: string[] = []
  for (const row of rows) {
    const runId = nextId('run')
    store.emailCampaignRun.push({ id: runId, campaignId, status: row.runStatus, snapshot: {}, startedAt: new Date(NOW - MINUTE), updatedAt: new Date(NOW - MINUTE) })
    const recipientId = nextId('rec')
    ids.push(recipientId)
    store.emailCampaignRecipient.push({
      id: recipientId,
      runId,
      email: EMAIL,
      status: 'DEFERRED',
      reason: 'suppression_read_failed',
      batchIndex: 0,
      attempts: 1,
      transientAttempts: 1,
      nextAttemptAt: null,
      emailSendId: null,
      createdAt: new Date(NOW - MINUTE),
      updatedAt: new Date(NOW - MINUTE),
      ...row,
    })
  }
  const deps = {
    guardedSend: async () => {
      throw new Error('the sweep must not send')
    },
    buildRecipientContext: async () => ({ ok: true, payload: {} }),
    renderTemplate: async () => ({ html: '', text: '' }),
    enqueue: async (name: string, _d: unknown, opts: { jobId: string; delay?: number }) => {
      enqueued.push({ name, opts })
      return { id: opts.jobId }
    },
    now: () => NOW,
  }
  return { deps, enqueued, ids }
}

test('the sweep re-drives ONLY overdue deferrals that carry a due time, on sendable runs', async () => {
  const { dispatch } = await load()
  const { deps, enqueued, ids } = await sweepHarness([
    { runStatus: 'SENDING', nextAttemptAt: new Date(NOW - 10 * MINUTE) }, // A: overdue → re-driven
    { runStatus: 'SENDING', nextAttemptAt: null }, // B: legacy row, deliberately untouched
    { runStatus: 'CANCELLING', nextAttemptAt: new Date(NOW - 10 * MINUTE) }, // C: run not sendable
    { runStatus: 'SENDING', nextAttemptAt: new Date(NOW - MINUTE) }, // D: inside the grace window
  ])
  const out = await dispatch.sweepCampaignRuns(deps as never)

  const retries = enqueued.filter((e) => e.name === 'campaign-recipient-retry')
  assert.equal(retries.length, 1, 'exactly the overdue row on a sendable run')
  assert.equal(out.redriven, 1)
  assert.ok(retries[0].opts.jobId.includes(ids[0]), 'and it must be row A')
  assert.match(retries[0].opts.jobId, /__sweep__\d+$/, 'a time bucket keeps a retained completed job from swallowing the add')
  assert.ok(!retries[0].opts.jobId.includes(':'))
})

test('the sweep adds no re-drive jobs at all while dispatch is paused', async () => {
  const { dispatch } = await load()
  const { deps, enqueued } = await sweepHarness([{ runStatus: 'SENDING', nextAttemptAt: new Date(NOW - 10 * MINUTE) }])
  store.emailAgentSettings.push({ id: 'singleton', marketingDispatchPaused: true, pausedReason: null, pausedAt: null, pausedBy: 'owner' })
  const out = await dispatch.sweepCampaignRuns(deps as never)
  assert.equal(enqueued.filter((e) => e.name === 'campaign-recipient-retry').length, 0, 'a paused retry job would only return early — churning 200 no-op jobs every tick')
  assert.equal(out.redriven, 0)
})

test('the sweep never creates a second run for a SCHEDULED campaign whose run already ran', async () => {
  const { dispatch } = await load()
  reset()
  const campaignId = nextId('camp')
  store.marketingCampaign.push({ id: campaignId, channel: 'EMAIL', status: 'SCHEDULED', sourceKey: `test_resched_${campaignId}` })
  store.emailCampaignConfig.push({ id: nextId('cfg'), campaignId, scheduledAt: new Date(NOW - 60 * MINUTE), approvedAt: new Date(NOW - 120 * MINUTE), statusNote: null })
  store.emailCampaignRun.push({ id: nextId('run'), campaignId, status: 'COMPLETED', snapshot: {}, sentCount: 3, startedAt: new Date(NOW - 50 * MINUTE), updatedAt: new Date(NOW - 50 * MINUTE) })

  const out = await dispatch.sweepCampaignRuns({
    guardedSend: async () => {
      throw new Error('the sweep must not send')
    },
    buildRecipientContext: async () => ({ ok: true, payload: {} }),
    renderTemplate: async () => ({ html: '', text: '' }),
    enqueue: async () => ({}),
    now: () => NOW,
  } as never)

  assert.equal(out.dispatched, 0)
  assert.equal(store.emailCampaignRun.length, 1, 'a whole audience must never be re-mailed by an automatic tick')
  const note = store.emailCampaignConfig[0].statusNote as string
  assert.match(note, /already dispatched this campaign/, 'and the anomaly is visible to the owner')
})

// ── 7. Automations: a read failure retries the stage, it does not spend it ──

test('an automation stage deferral writes nextRunAt BEFORE it enqueues, with a colon-free bucketed id', async () => {
  const { runtime } = await load()
  const order: string[] = []
  let written: { nextRunAt: Date; history: unknown[] } | null = null
  const result = await runtime.deferStageForTransientFailure(
    { enrollmentId: 'enr_1', stageIndex: 1, stageKey: 'stage-2', history: [], reason: 'suppression_read_failed', jobIdBase: 'automation__a1__v2__stage-2__enr_1' },
    {
      writeDeferral: async (_id, _stage, data) => {
        order.push('write')
        written = data
        return 1
      },
      enqueue: async (_d, opts) => {
        order.push('enqueue')
        assert.ok(written, 'the durable due time must already be committed')
        assert.ok(!opts.jobId.includes(':'), 'BullMQ rejects a custom id containing ":"')
        assert.match(opts.jobId, /__transient__\d+$/, 'time-bucketed, not derived from a best-effort history write')
        assert.equal(opts.delay, 5 * MINUTE)
        return {}
      },
      now: () => NOW,
    }
  )
  assert.deepEqual(order, ['write', 'enqueue'], 'a lost enqueue must still leave a row the sweep can recover')
  assert.equal(result.deferred, true)
  if (result.deferred) assert.equal(result.at.getTime(), NOW + 5 * MINUTE)
  assert.equal(written!.nextRunAt.getTime(), NOW + 5 * MINUTE)
  assert.equal((written!.history[0] as { outcome: string }).outcome, 'transient_retry')
})

test('an automation stage is skipped only once its transient budget is spent', async () => {
  const { runtime } = await load()
  const history = Array.from({ length: runtime.AUTOMATION_TRANSIENT_MAX_ATTEMPTS - 1 }, () => ({ stage: 0, outcome: 'transient_retry' }))
  assert.equal(runtime.countTransientRetries(history, 0), runtime.AUTOMATION_TRANSIENT_MAX_ATTEMPTS - 1)
  assert.equal(runtime.countTransientRetries(history, 1), 0, 'only THIS stage counts')

  let enqueued = 0
  const out = await runtime.deferStageForTransientFailure(
    { enrollmentId: 'enr_1', stageIndex: 0, stageKey: 's', history, reason: 'suppression_read_failed', jobIdBase: 'b' },
    { writeDeferral: async () => 1, enqueue: async () => (enqueued++, {}), now: () => NOW }
  )
  assert.equal(out.deferred, false)
  if (!out.deferred) assert.equal(out.reason, 'exhausted')
  assert.equal(enqueued, 0)
})

test('a stage whose enrollment moved on concurrently is not re-queued', async () => {
  const { runtime } = await load()
  let enqueued = 0
  const out = await runtime.deferStageForTransientFailure(
    { enrollmentId: 'enr_1', stageIndex: 0, stageKey: 's', history: [], reason: 'context_error:timeout', jobIdBase: 'b' },
    { writeDeferral: async () => 0, enqueue: async () => (enqueued++, {}), now: () => NOW }
  )
  assert.equal(out.deferred, false)
  if (!out.deferred) assert.equal(out.reason, 'superseded')
  assert.equal(enqueued, 0, 'a superseded stage must not schedule work for a pointer that moved')
})

// ── 8. The whole file never touched the provider ────────────────────────

test('no test in this file reached the email provider', async () => {
  const { sendSpy } = await load()
  assert.equal(sendSpy.mock.callCount(), 0)
})
