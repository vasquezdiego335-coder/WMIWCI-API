import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Job, Queue, Worker, UnrecoverableError } from 'bullmq'
import { redisSkip, assertTestRecipient, assertNoProductionCredentials } from './_disposable-test-env'
import {
  DEFERRAL_BUFFER_MS,
  deferralDueAt,
  deferredJobId,
  isBullmqSafeCustomId,
  isTransientRefusal,
  queueSafeJobId,
  type RefusalLike,
} from '../email-deferral'
import { validateEmailJobData } from '../email-job-validation'

// ════════════════════════════════════════════════════════════════════════
//  EMAIL DEFERRAL + JOB IDS + MALFORMED JOBS (production fix 2026-09-15)
//  ---------------------------------------------------------------------
//  1. A refused send is re-driven only when the guard supplied a due time.
//  2. Deferred job ids must survive MANY hops. The old `${id}:deferred:${reason}`
//     id passed BullMQ's 3-part colon carve-out once and threw
//     "Custom Id cannot contain :" on the second hop, dropping the email.
//  3. A malformed email job fails once, alone, without retries.
//  Offline except the REDIS_TEST_URL-gated test at the bottom.
// ════════════════════════════════════════════════════════════════════════

assertNoProductionCredentials()

const RECIPIENT = 'customer@example.com'
assertTestRecipient(RECIPIENT)

/**
 * Exercise BullMQ's OWN custom-id validation (node_modules/bullmq/dist/cjs/classes/job.js,
 * Job#validateOptions, "Custom Id cannot be integers" / "Custom Id cannot contain :"
 * around lines 1041-1051). validateOptions reads only `this.opts` / `this.name`, so it
 * runs without Redis. Returns the thrown message, or null when the id is accepted.
 */
function bullmqRejects(jobId: string): string | null {
  const fakeJob = { name: 'test', opts: { jobId } }
  const validate = (Job.prototype as unknown as { validateOptions: (d: unknown) => void }).validateOptions
  assert.equal(typeof validate, 'function', 'bullmq Job#validateOptions must exist (did bullmq change?)')
  try {
    validate.call(fakeJob, { data: '{}' })
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

test('sanity: bullmq validation harness reproduces the real rule', () => {
  assert.equal(bullmqRejects('abc'), null)
  assert.equal(bullmqRejects('123'), 'Custom Id cannot be integers')
  assert.equal(bullmqRejects('a:b:c'), null, '3-part carve-out')
  assert.equal(bullmqRejects('a:b'), 'Custom Id cannot contain :')
  assert.equal(bullmqRejects('a:b:c:d:e'), 'Custom Id cannot contain :')
})

// ── 1. deferralDueAt ───────────────────────────────────────────────────────
test('deferralDueAt: retryAt wins over notDueUntil', () => {
  const now = 1_000_000
  const retryAt = new Date(now + 60_000)
  const notDueUntil = new Date(now + 5_000)
  assert.equal(
    deferralDueAt({ sent: false, reason: 'not_due', retryAt, notDueUntil }, now),
    retryAt.getTime() + DEFERRAL_BUFFER_MS,
  )
  assert.equal(deferralDueAt({ sent: false, reason: 'quiet_hours', retryAt }, now), now + 60_000 + 1000)
})

test("deferralDueAt: reason 'not_due' + notDueUntil → due + 1000ms", () => {
  const now = 2_000_000
  const due = new Date(now + 120_000)
  assert.equal(deferralDueAt({ sent: false, reason: 'not_due', notDueUntil: due }, now), due.getTime() + 1000)
})

test('deferralDueAt: a past due time → now + 1000', () => {
  const now = 3_000_000
  assert.equal(deferralDueAt({ sent: false, reason: 'not_due', notDueUntil: new Date(now - 50_000) }, now), now + 1000)
  assert.equal(deferralDueAt({ sent: false, reason: 'daily_cap', retryAt: new Date(now - 1) }, now), now + 1000)
})

test("deferralDueAt: in_flight / ambiguous / sent / no times → null", () => {
  const now = 4_000_000
  const later = new Date(now + 10_000)
  assert.equal(deferralDueAt({ sent: false, reason: 'in_flight', retryAt: later, notDueUntil: later }, now), null)
  assert.equal(deferralDueAt({ sent: false, reason: 'ambiguous', retryAt: later }, now), null)
  assert.equal(deferralDueAt({ sent: true }, now), null)
  assert.equal(deferralDueAt({ sent: false, reason: 'not_due' }, now), null)
  assert.equal(deferralDueAt({ sent: false, reason: 'suppressed' }, now), null)
  assert.equal(deferralDueAt({ sent: false, reason: 'quiet_hours', retryAt: new Date(NaN) }, now), null)
})

test("deferralDueAt: notDueUntil is ignored when reason is not 'not_due'", () => {
  const now = 5_000_000
  assert.equal(deferralDueAt({ sent: false, reason: 'suppressed', notDueUntil: new Date(now + 10_000) }, now), null)
  assert.equal(deferralDueAt({ sent: false, reason: 'duplicate', notDueUntil: new Date(now + 10_000) }, now), null)
})

// ── 2. isTransientRefusal ─────────────────────────────────────────────────
test('isTransientRefusal table', () => {
  const later = new Date(Date.now() + 60_000)
  const rows: Array<[string, RefusalLike, boolean]> = [
    ['not_due + notDueUntil', { sent: false, reason: 'not_due', notDueUntil: later }, true],
    ['retryAt deferral', { sent: false, reason: 'quiet_hours', retryAt: later, outcomeClass: 'deferred' }, true],
    ['retryAt deferral without class', { sent: false, reason: 'kill_switch', retryAt: later }, true],
    ['claim_lookup_failed', { sent: false, reason: 'claim_lookup_failed' }, true],
    ["outcomeClass 'retryable'", { sent: false, reason: 'db_read_failed', outcomeClass: 'retryable' }, true],
    ['recorded:false', { sent: false, reason: 'suppressed', outcomeClass: 'blocked_terminal', recorded: false }, true],
    ['in_flight', { sent: false, reason: 'in_flight', retryAt: later, outcomeClass: 'retryable' }, false],
    ['ambiguous reason', { sent: false, reason: 'ambiguous', retryAt: later }, false],
    ['ambiguous class', { sent: false, reason: 'provider_timeout', outcomeClass: 'ambiguous', recorded: false }, false],
    ['duplicate', { sent: false, reason: 'duplicate', outcomeClass: 'retryable' }, false],
    ['terminal: blocked_terminal', { sent: false, reason: 'suppressed', outcomeClass: 'blocked_terminal' }, false],
    ["outcomeClass 'terminal'", { sent: false, reason: 'ineligible', outcomeClass: 'terminal' }, false],
    ['attempts_exhausted', { sent: false, reason: 'attempts_exhausted', outcomeClass: 'terminal' }, false],
    ['attempts_exhausted (no class)', { sent: false, reason: 'attempts_exhausted' }, false],
    ['sent', { sent: true }, false],
  ]
  for (const [name, outcome, expected] of rows) {
    assert.equal(isTransientRefusal(outcome), expected, `${name} → expected ${expected}`)
  }
})

// ── 3. deferredJobId ──────────────────────────────────────────────────────
test('deferredJobId: a 5-hop chain from "27" is always BullMQ-safe, unique, and rooted at 27', () => {
  const base = 1_800_000_000_000
  const ids: string[] = []
  let parent: string = '27'
  for (let hop = 0; hop < 5; hop++) {
    const id = deferredJobId(parent, hop % 2 ? 'not_due' : 'quiet_hours', base + hop * 60_000)
    assert.ok(isBullmqSafeCustomId(id), `hop ${hop + 1} not safe per isBullmqSafeCustomId: ${id}`)
    assert.equal(bullmqRejects(id), null, `hop ${hop + 1} rejected by BullMQ: ${id}`)
    assert.ok(!id.includes(':'))
    assert.notEqual(`${parseInt(id, 10)}`, id)
    assert.ok(id.startsWith('27__deferred__'), `hop ${hop + 1} lost root 27: ${id}`)
    assert.equal(id.split('__deferred__')[0], '27')
    ids.push(id)
    parent = id
  }
  assert.equal(new Set(ids).size, ids.length, 'every hop id must differ')
})

test('deferredJobId: same reason on consecutive hops still yields distinct ids (due time differs)', () => {
  const a = deferredJobId('27', 'quiet_hours', 1000)
  const b = deferredJobId(a, 'quiet_hours', 2000)
  assert.notEqual(a, b)
  assert.notEqual(b, a, 'a same-id add is a silent no-op in BullMQ')
  assert.equal(deferredJobId('27', 'quiet_hours', 1000), a, 'deterministic')
})

test("deferredJobId: legacy parent '27:deferred:quiet_hours' → root 27", () => {
  const id = deferredJobId('27:deferred:quiet_hours', 'quiet_hours', 1_700_000_000_000)
  assert.equal(id, '27__deferred__quiet_hours__1700000000000')
  assert.equal(bullmqRejects(id), null)
})

test('deferredJobId: odd reasons and parents are sanitised', () => {
  const id = deferredJobId('27', 'validation: x y', 123.9)
  assert.equal(id, '27__deferred__validation__x_y__123')
  assert.ok(isBullmqSafeCustomId(id))
  assert.equal(bullmqRejects(id), null)
  const empty = deferredJobId(undefined, '', 5)
  assert.equal(empty, 'nojob__deferred__unknown__5')
  const colonRoot = deferredJobId('a:b', 'x', 5)
  assert.ok(!colonRoot.includes(':'))
  assert.equal(bullmqRejects(colonRoot), null)
  assert.ok(deferredJobId('1', 'r'.repeat(200), 1).length < 100, 'reason is truncated')
})

test('REGRESSION: the OLD `${id}:deferred:${reason}` shape fails BullMQ on hop 2', () => {
  const hop1 = `27:deferred:quiet_hours`
  const hop2 = `${hop1}:deferred:quiet_hours`
  assert.equal(bullmqRejects(hop1), null, 'hop 1 slipped through the 3-part carve-out')
  assert.equal(bullmqRejects(hop2), 'Custom Id cannot contain :')
  assert.equal(isBullmqSafeCustomId(hop1), false, 'our rule is stricter: never rely on the carve-out')
  assert.equal(isBullmqSafeCustomId(hop2), false)
})

// ── 4. queueSafeJobId ─────────────────────────────────────────────────────
test('queueSafeJobId: colon-free, deterministic, never an integer string', () => {
  const lead = queueSafeJobId('lead-notify:lead_created:abc')
  assert.ok(!lead.includes(':'))
  assert.equal(lead, queueSafeJobId('lead-notify:lead_created:abc'))
  assert.notEqual(lead, queueSafeJobId('lead-notify:lead_created:abd'))
  assert.equal(bullmqRejects(lead), null)

  const dep = queueSafeJobId('deposit-paid:dep_1')
  assert.ok(!dep.includes(':'))
  assert.equal(bullmqRejects(dep), null)

  const num = queueSafeJobId('123')
  assert.notEqual(`${parseInt(num, 10)}`, num)
  assert.ok(isBullmqSafeCustomId(num))
  assert.equal(bullmqRejects(num), null)
})

// ── 5. validateEmailJobData ───────────────────────────────────────────────
test('validateEmailJobData: valid shape → null', () => {
  assert.equal(validateEmailJobData({ template: 'pre-approval', to: RECIPIENT }), null)
  assert.equal(
    validateEmailJobData({ template: 'pre-approval', to: RECIPIENT, payload: { a: 1 }, bookingId: 'bk_1', leadId: null }),
    null,
  )
})

test('validateEmailJobData: malformed shapes → problem strings', () => {
  const bad: Array<[string, unknown]> = [
    ['null', null],
    ['array', []],
    ['empty object', {}],
    ['missing template', { to: RECIPIENT }],
    ['blank template', { template: '  ', to: RECIPIENT }],
    ['missing to', { template: 'pre-approval' }],
    ['payload string', { template: 'pre-approval', to: RECIPIENT, payload: 'x' }],
    ['payload array', { template: 'pre-approval', to: RECIPIENT, payload: [1] }],
    ['bookingId number', { template: 'pre-approval', to: RECIPIENT, bookingId: 42 }],
  ]
  for (const [name, data] of bad) {
    const problem = validateEmailJobData(data)
    assert.equal(typeof problem, 'string', `${name} must be rejected`)
    assert.ok((problem as string).length > 0)
  }
  assert.match(validateEmailJobData({ template: 'x', to: RECIPIENT, bookingId: 42 }) as string, /bookingId/)
})

// ── 6. processEmailJob rejects malformed data before touching anything ────
test('processEmailJob: malformed job throws UnrecoverableError without touching the database', async () => {
  const touched: string[] = []
  const g = globalThis as unknown as { prisma?: unknown }
  const previous = g.prisma
  g.prisma = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === 'symbol') return undefined
        touched.push(prop)
        throw new Error(`fake prisma touched: ${prop}`)
      },
    },
  )
  try {
    const { processEmailJob } = await import('../../workers/email.worker')
    const job = { id: '1', name: 'x', data: { template: '', to: '' } } as unknown as Parameters<typeof processEmailJob>[0]
    await assert.rejects(
      () => processEmailJob(job),
      (err: unknown) => {
        assert.ok(err instanceof UnrecoverableError, `expected UnrecoverableError, got ${String(err)}`)
        assert.match((err as Error).message, /malformed email job/)
        return true
      },
    )
    assert.deepEqual(touched, [], 'guardedSend / prisma must not be reached')
  } finally {
    // db.ts may have captured the proxy; restore the global for any later import.
    if (previous === undefined) delete g.prisma
    else g.prisma = previous
  }
})

// ── 7. Real BullMQ: malformed job fails once, valid job still completes ────
test('BullMQ: UnrecoverableError sends a malformed job to failed after 1 attempt; valid job completes', { skip: redisSkip() }, async () => {
  const u = new URL(process.env.REDIS_TEST_URL!)
  const connection = {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    maxRetriesPerRequest: null,
  }
  const name = `email-malformed-test-${process.pid}-${Date.now()}`
  const queue = new Queue(name, { connection, defaultJobOptions: { attempts: 3, backoff: { type: 'fixed', delay: 10 } } })
  let worker: Worker | undefined
  try {
    const bad = await queue.add('x', { template: '', to: '' }, { jobId: queueSafeJobId('bad:1') })
    const good = await queue.add('pre-approval', { template: 'pre-approval', to: RECIPIENT }, { jobId: queueSafeJobId('good:1') })

    const processed: string[] = []
    let processorCalls = 0
    worker = new Worker(
      name,
      async (job) => {
        processorCalls++
        const problem = validateEmailJobData(job.data)
        if (problem) throw new UnrecoverableError(`malformed email job: ${problem}`)
        processed.push(String(job.id))
      },
      { connection, concurrency: 1 },
    )
    worker.on('error', () => {})

    // Poll job states (bounded) instead of counting events: a retried failure
    // and a final failure both emit 'failed', so state is the reliable signal.
    const deadline = Date.now() + 15_000
    for (;;) {
      const [b, g] = await Promise.all([queue.getJobState(bad.id!), queue.getJobState(good.id!)])
      if (b === 'failed' && g === 'completed') break
      if (Date.now() > deadline) throw new Error(`timed out: bad=${b} good=${g}`)
      await new Promise((r) => setTimeout(r, 50))
    }

    assert.deepEqual(processed, [good.id])
    const goodState = await queue.getJobState(good.id!)
    assert.equal(goodState, 'completed')

    const failed = await queue.getFailed()
    const badJob = failed.find((j) => j.id === bad.id)
    assert.ok(badJob, 'malformed job must be in the failed set')
    assert.equal(badJob!.opts.attempts, 3, 'queue default attempts applied')
    assert.equal(badJob!.attemptsMade, 1, 'UnrecoverableError must not burn retries')
    assert.match(badJob!.failedReason, /malformed email job/)
    assert.equal(processorCalls, 2)
  } finally {
    await worker?.close().catch(() => {})
    await queue.obliterate({ force: true }).catch(() => {})
    await queue.close().catch(() => {})
  }
})

// ── 8. A provider rejection on the LAST queue attempt is re-queued, not lost ──
test("email.worker: a ProviderRejectedError on the job's last attempt re-queues at the ledger due time", async () => {
  const { readFileSync } = await import("node:fs")
  const { resolve } = await import("node:path")
  const src = readFileSync(resolve(__dirname, "../../workers/email.worker.ts"), "utf8")
  assert.ok(src.includes("err instanceof ProviderRejectedError && err.retryAt && lastAttempt"), "only a definitive rejection with a due time, on the last attempt")
  assert.ok(src.includes("job.attemptsMade + 1 >= (job.opts?.attempts ?? 1)"), "last attempt is computed from BullMQ's own counters")
  assert.ok(src.includes("jobId: deferredJobId(job.id, 'not_due', dueAt)"), "colon-free id, identical to the not_due hop so a stalled re-run dedupes")
  assert.ok(/catch \(addErr\)[\s\S]{0,300}throw err/.test(src), "a failed re-queue still surfaces the provider rejection")
  assert.ok(/throw err\s*\}\)/.test(src), "every other error still reaches BullMQ")
  // The id the hop uses is BullMQ-safe.
  assert.equal(isBullmqSafeCustomId(deferredJobId("27", "provider_rejected", Date.now())), true)
})
