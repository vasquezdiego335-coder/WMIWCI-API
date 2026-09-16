// ════════════════════════════════════════════════════════════════════════
//  RECURRING SCHEDULES — registration that retries, verifies and heals
//  ---------------------------------------------------------------------
//  The scheduled worker registered its twelve crons once, fire-and-forget: the
//  first failure skipped the rest, an outage hung silently, a flushed Redis was
//  never repaired, and /healthz stayed green throughout. These tests pin the
//  replacement (src/lib/cron-schedules.ts):
//    • a Redis outage issues ZERO queue commands and reports every name missing;
//    • recovery registers everything on the next pass;
//    • one schedule failing never stops the other eleven, and is retried;
//    • repeated startups never create duplicates (fake keyed exactly like BullMQ,
//      plus a REDIS-GATED run against real BullMQ);
//    • a schedule that is PRESENT but no longer firing (BullMQ failed to create
//      its next iteration) is repaired by the latched forced re-add, and the
//      request is never dropped by a pass that is already running;
//    • a UTC schedule (tz undefined vs BullMQ's null) is never pruned;
//    • readiness names a missing schedule.
//  Offline except the gated test, which needs a disposable REDIS_TEST_URL.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  CRON_SCHEDULES,
  createCronReconciler,
  legacyRepeatKey,
  type CronQueue,
  type CronReconcilerOptions,
  type RepeatableEntry,
} from '../cron-schedules'
import { evaluateWorkerHealth, SCHEDULE_BOOT_GRACE_MS } from '../worker-health'
import { assertNoProductionCredentials, redisSkip } from './_disposable-test-env'

assertNoProductionCredentials()

const NAMES = CRON_SCHEDULES.map((s) => s.name)

// ── A fake Redis keyed exactly like BullMQ's legacy repeatables ─────────
type Live = { key: string; name: string; pattern: string | null; tz: string | null }

function fakeQueue(seed: Live[] = []) {
  const live = new Map<string, Live>(seed.map((e) => [e.key, e]))
  const calls = { add: [] as string[], list: 0, remove: [] as string[] }
  let addFailure: (name: string, attempt: number) => Error | 'hang' | null = () => null
  let addGate: (name: string) => Promise<void> | null = () => null
  const attempts = new Map<string, number>()
  let holes = 0
  const queue: CronQueue = {
    async add(name, data, opts) {
      calls.add.push(name)
      const n = (attempts.get(name) ?? 0) + 1
      attempts.set(name, n)
      assert.deepEqual(data, { type: name }, 'job data must stay { type: name }')
      const failure = addFailure(name, n)
      if (failure === 'hang') return new Promise(() => undefined)
      if (failure) throw failure
      // A releasable park, so a test can hold a pass open inside the loop.
      const gate = addGate(name)
      if (gate) await gate
      const key = legacyRepeatKey({ name: name as never, pattern: opts.repeat.pattern, tz: opts.repeat.tz, jobId: opts.jobId })
      // BullMQ normalises a missing tz to null (repeat.js getRepeatableData).
      live.set(key, { key, name, pattern: opts.repeat.pattern, tz: opts.repeat.tz || null })
    },
    async getRepeatableJobs() {
      calls.list++
      const out: Array<RepeatableEntry | undefined> = [...live.values()].map((e) => ({ ...e }))
      for (let i = 0; i < holes; i++) out.push(undefined)
      return out
    },
    async removeRepeatableByKey(key) {
      calls.remove.push(key)
      return live.delete(key)
    },
  }
  return {
    queue,
    live,
    calls,
    totalCalls: () => calls.add.length + calls.list + calls.remove.length,
    failAdd(fn: typeof addFailure) {
      addFailure = fn
    },
    gateAdd(fn: typeof addGate) {
      addGate = fn
    },
    addHoles(n: number) {
      holes = n
    },
  }
}

/** Let every queued microtask and resolved promise run. */
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((res) => setImmediate(res))
}

const liveEntry = (name: string, pattern: string, tz: string | undefined, jobId = `cron:${name}`): Live => ({
  key: legacyRepeatKey({ name: name as never, pattern, tz, jobId }),
  name,
  pattern,
  tz: tz || null,
})

function reconciler(q: ReturnType<typeof fakeQueue>, extra: Partial<CronReconcilerOptions> = {}) {
  return createCronReconciler({ queue: q.queue, redisOk: async () => true, sleep: async () => undefined, ...extra })
}

// ── The registry is exactly what production Redis holds ─────────────────

test('CRON_SCHEDULES: the 12 names, patterns, tz and jobIds are byte-identical to production', () => {
  assert.deepEqual(
    CRON_SCHEDULES.map((s) => [s.name, s.pattern, s.tz, s.jobId]),
    [
      ['daily-schedule-morning', '0 7 * * *', 'America/New_York', 'cron:daily-schedule-morning'],
      ['daily-schedule-evening', '0 19 * * *', 'America/New_York', 'cron:daily-schedule-evening'],
      ['campaign-sweep', '*/15 * * * *', undefined, 'cron:campaign-sweep'],
      ['lead-notification-sweep', '*/15 * * * *', undefined, 'cron:lead-notification-sweep'],
      ['automation-sweep', '*/15 * * * *', undefined, 'cron:automation-sweep'],
      ['outbox-email-recovery', '*/15 * * * *', undefined, 'cron:outbox-email-recovery'],
      ['email-side-effect-sweep', '*/15 * * * *', undefined, 'cron:email-side-effect-sweep'],
      ['email-monitoring', '*/15 * * * *', undefined, 'cron:email-monitoring'],
      ['email-agent-cycle', '*/15 * * * *', undefined, 'cron:email-agent-cycle'],
      ['lead-maintenance', '20 3 * * *', 'America/New_York', 'cron:lead-maintenance'],
      ['marketing-discovery', '5 10 * * *', 'America/New_York', 'cron:marketing-discovery'],
      ['lifecycle-repair', '0 * * * *', undefined, 'cron:lifecycle-repair'],
    ],
  )
  assert.equal(new Set(NAMES).size, 12, 'names must be unique')
  const contract = readFileSync(resolve(__dirname, '../queues/index.ts'), 'utf8')
  for (const n of NAMES) assert.ok(contract.includes(`| '${n}'`), `${n} must be a ScheduledJobData type the worker dispatches`)
  const worker = readFileSync(resolve(__dirname, '../../workers/scheduled.worker.ts'), 'utf8')
  for (const n of NAMES) assert.ok(worker.includes(`case '${n}'`), `the scheduled worker must handle ${n}`)
})

test('legacyRepeatKey matches the BullMQ concat shape name:jobId:endDate:tz:pattern (md5)', () => {
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  const md5 = (s: string) => createHash('md5').update(s).digest('hex')
  assert.equal(legacyRepeatKey(CRON_SCHEDULES[0]), md5('daily-schedule-morning:cron:daily-schedule-morning::America/New_York:0 7 * * *'))
  assert.equal(legacyRepeatKey(CRON_SCHEDULES[2]), md5('campaign-sweep:cron:campaign-sweep:::*/15 * * * *'))
})

// ── Redis unavailable / recovering ──────────────────────────────────────

test('Redis unavailable at startup: PING false → ZERO queue calls, every schedule missing, readiness unhealthy', async () => {
  const q = fakeQueue()
  const r = reconciler(q, { redisOk: async () => false })
  const s = await r.reconcileOnce()
  assert.equal(q.totalCalls(), 0, 'no command may be issued into the offline queue during an outage')
  assert.equal(s.ok, false)
  assert.equal(s.firstPassDone, false, 'nothing was verified')
  assert.deepEqual(s.missing, NAMES)
  assert.deepEqual(s.registered, [])
  assert.ok(s.lastErrors.some((e) => e.name === 'redis'))

  // Within the boot grace an unverified host is not blamed for schedules (PING
  // already makes it 503); after the grace every name is listed.
  const base = { envMissing: [], redis: { ok: false }, workers: [], expectedWorkers: 0 }
  assert.ok(!evaluateWorkerHealth({ ...base, schedules: { status: s, bootGraceElapsed: false } }).problems.some((p) => /recurring/.test(p)))
  const late = evaluateWorkerHealth({ ...base, schedules: { status: s, bootGraceElapsed: true } })
  assert.equal(late.ok, false)
  for (const n of NAMES) assert.ok(late.problems.includes(`recurring schedule "${n}" is not registered`), `must name ${n}`)
})

test('a PING that hangs is bounded and still issues no queue call', async () => {
  const q = fakeQueue()
  const r = reconciler(q, { redisOk: () => new Promise<boolean>(() => undefined), callTimeoutMs: 30 })
  const s = await r.reconcileOnce()
  assert.equal(q.totalCalls(), 0)
  assert.deepEqual(s.missing, NAMES)
})

test('Redis recovering after startup: the next pass registers all 12 and readiness becomes healthy', async () => {
  const q = fakeQueue()
  let up = false
  const r = reconciler(q, { redisOk: async () => up })
  assert.equal((await r.reconcileOnce()).ok, false)
  assert.equal(q.totalCalls(), 0)
  up = true
  const s = await r.reconcileOnce()
  assert.equal(s.ok, true)
  assert.equal(s.firstPassDone, true)
  assert.deepEqual(s.registered, NAMES)
  assert.deepEqual(s.missing, [])
  assert.equal(q.live.size, 12)
  const v = evaluateWorkerHealth({ envMissing: [], redis: { ok: true }, workers: [], expectedWorkers: 0, schedules: { status: s, bootGraceElapsed: true } })
  assert.deepEqual(v, { ok: true, problems: [] })
})

test('Redis lost after verification: earlier verification stands, no queue call, next good pass re-verifies', async () => {
  const q = fakeQueue()
  let up = true
  const r = reconciler(q, { redisOk: async () => up })
  await r.reconcileOnce()
  const before = q.totalCalls()
  up = false
  const s = await r.reconcileOnce()
  assert.equal(q.totalCalls(), before)
  assert.deepEqual(s.registered, NAMES, 'a PING failure is not evidence that the schedules vanished')
  assert.ok(s.lastErrors.some((e) => e.name === 'redis'))
})

// ── Isolation and retry ─────────────────────────────────────────────────

test('one schedule failing: the other 11 register, the failure is retried in-pass and registered on a later pass', async () => {
  const q = fakeQueue()
  let broken = true
  q.failAdd((name) => (broken && name === 'email-monitoring' ? new Error('ERR script error at redis://u:hunter2@10.0.0.1:6379') : null))
  const r = reconciler(q, { addAttempts: 3 })
  const first = await r.reconcileOnce()
  assert.equal(first.ok, false)
  assert.deepEqual(first.missing, ['email-monitoring'])
  assert.deepEqual(first.registered, NAMES.filter((n) => n !== 'email-monitoring'))
  assert.equal(q.calls.add.filter((n) => n === 'email-monitoring').length, 3, 'bounded in-pass retries')
  // Schedules AFTER the failing one were still attempted.
  assert.ok(q.calls.add.includes('lifecycle-repair') && q.calls.add.includes('marketing-discovery'))
  const err = first.lastErrors.find((e) => e.name === 'email-monitoring')
  assert.ok(err && !err.message.includes('hunter2'), `error must be sanitized: ${err?.message}`)

  broken = false
  const second = await r.reconcileOnce()
  assert.equal(second.ok, true)
  assert.deepEqual(second.registered, NAMES)
  assert.equal(q.live.size, 12)
})

test('an add that never answers times out; the remaining schedules are still attempted', async () => {
  const q = fakeQueue()
  q.failAdd((name) => (name === 'campaign-sweep' ? 'hang' : null))
  const r = reconciler(q, { callTimeoutMs: 25, addAttempts: 2 })
  const s = await r.reconcileOnce()
  assert.deepEqual(s.missing, ['campaign-sweep'])
  assert.equal(s.registered.length, 11)
  assert.match(s.lastErrors.find((e) => e.name === 'campaign-sweep')?.message ?? '', /timed out/)
})

test('Redis dropping mid-pass stops further queue commands for that pass', async () => {
  const q = fakeQueue()
  let up = true
  q.failAdd((name) => {
    if (name === 'automation-sweep') {
      up = false
      return new Error('Connection is closed.')
    }
    return null
  })
  const r = reconciler(q, { redisOk: async () => up, addAttempts: 3 })
  const s = await r.reconcileOnce()
  const idx = NAMES.indexOf('automation-sweep')
  assert.deepEqual(q.calls.add, NAMES.slice(0, idx + 1), 'no schedule after the outage was attempted, and no blind retry')
  assert.equal(s.ok, false)
  assert.ok(s.lastErrors.some((e) => e.name === 'redis'))
})

// ── Idempotency / duplicates ────────────────────────────────────────────

test('repeated startups create no duplicates; one repair pass per startup, nothing afterwards', async () => {
  const q = fakeQueue()
  for (let startup = 0; startup < 3; startup++) {
    const r = reconciler(q)
    for (let pass = 0; pass < 3; pass++) assert.equal((await r.reconcileOnce()).ok, true)
  }
  assert.equal(q.live.size, 12)
  for (const n of NAMES) assert.equal([...q.live.values()].filter((e) => e.name === n).length, 1, n)
  // Every startup re-adds all twelve on its first pass — the boot repair the
  // worker used to do inline — and the identical add hashes to the same repeat
  // key, so three startups still leave exactly twelve entries. Later passes in
  // the same process write nothing.
  assert.equal(q.calls.add.length, 36, 'exactly one repair pass per startup')
  for (let startup = 0; startup < 3; startup++) assert.deepEqual(q.calls.add.slice(startup * 12, startup * 12 + 12), NAMES, `startup ${startup}`)
  assert.deepEqual(q.calls.remove, [])
})

test('the production state (12 legacy entries already live): the boot pass re-adds in place, then leaves it alone', async () => {
  const q = fakeQueue(CRON_SCHEDULES.map((s) => liveEntry(s.name, s.pattern, s.tz)))
  const keysBefore = [...q.live.keys()].sort()
  const r = reconciler(q)
  assert.equal((await r.reconcileOnce()).ok, true)
  // The first pass is a repair pass: it re-adds every schedule, which is how a
  // delayed iteration lost while the worker was down comes back. The entries
  // themselves are unchanged, because an identical add overwrites the same key.
  assert.deepEqual([...q.calls.add].sort(), [...NAMES].sort())
  assert.deepEqual([...q.live.keys()].sort(), keysBefore, 'an override re-add never creates a second entry')
  assert.deepEqual(q.calls.remove, [])
  q.calls.add.length = 0
  assert.equal((await r.reconcileOnce()).ok, true)
  assert.deepEqual(q.calls.add, [], 'the steady-state verification writes nothing')
  assert.deepEqual(q.calls.remove, [])
})

test('UTC schedules are never pruned: tz undefined (desired) equals tz null/empty (as Redis returns it)', async () => {
  const seed = CRON_SCHEDULES.map((s) => liveEntry(s.name, s.pattern, s.tz))
  for (const e of seed) if (e.tz === null && e.name === 'campaign-sweep') (e as { tz: string | null }).tz = ''
  const q = fakeQueue(seed)
  const r = reconciler(q)
  assert.equal((await r.reconcileOnce()).ok, true)
  assert.deepEqual(q.calls.remove, [], 'a UTC entry must never be treated as stale')
  q.calls.add.length = 0
  assert.equal((await r.reconcileOnce()).ok, true)
  assert.deepEqual(q.calls.add, [], 'and once the repair pass has settled it is not re-added either')
  assert.deepEqual(q.calls.remove, [])
})

test('same-name entries with a stale pattern or tz are pruned; unmanaged names and holes are never touched', async () => {
  const seed = CRON_SCHEDULES.map((s) => liveEntry(s.name, s.pattern, s.tz)).filter((e) => e.name !== 'lead-maintenance' && e.name !== 'campaign-sweep')
  const staleTz = liveEntry('lead-maintenance', '20 3 * * *', undefined) // lost its timezone
  const stalePattern = liveEntry('campaign-sweep', '*/5 * * * *', undefined)
  const unmanaged = liveEntry('someone-elses-cron', '*/1 * * * *', undefined)
  const q = fakeQueue([...seed, staleTz, stalePattern, unmanaged])
  q.addHoles(2)
  const r = reconciler(q)
  const s = await r.reconcileOnce()
  assert.equal(s.ok, true, JSON.stringify(s.lastErrors))
  assert.deepEqual(q.calls.remove.sort(), [staleTz.key, stalePattern.key].sort())
  assert.ok(q.live.has(unmanaged.key), 'unmanaged names are never removed')
  // The repair pass re-adds all twelve; the two that existed only under a stale
  // key are the ones that must be, and each name ends up live exactly once.
  assert.deepEqual([...q.calls.add].sort(), [...NAMES].sort())
  assert.equal([...q.live.values()].find((e) => e.name === 'lead-maintenance')?.tz, 'America/New_York')
  for (const n of NAMES) assert.equal([...q.live.values()].filter((e) => e.name === n).length, 1, n)
  q.calls.add.length = 0
  q.calls.remove.length = 0
  assert.equal((await r.reconcileOnce()).ok, true)
  assert.deepEqual(q.calls.add, [], 'the settled state needs no further writes')
  assert.deepEqual(q.calls.remove, [])
})

test('the desired schedule is added BEFORE a stale one is removed (a failed add never leaves a name with nothing)', async () => {
  const stale = liveEntry('lifecycle-repair', '35 * * * *', undefined)
  const q = fakeQueue([...CRON_SCHEDULES.filter((s) => s.name !== 'lifecycle-repair').map((s) => liveEntry(s.name, s.pattern, s.tz)), stale])
  q.failAdd((name) => (name === 'lifecycle-repair' ? new Error('OOM command not allowed') : null))
  const s = await reconciler(q, { addAttempts: 1 }).reconcileOnce()
  assert.deepEqual(q.calls.remove, [], 'nothing removed when the replacement could not be added')
  assert.ok(q.live.has(stale.key))
  assert.deepEqual(s.missing, ['lifecycle-repair'])
})

test('two identical live copies are reported (missing + error), never auto-deleted', async () => {
  const seed = CRON_SCHEDULES.map((s) => liveEntry(s.name, s.pattern, s.tz))
  seed.push(liveEntry('email-agent-cycle', '*/15 * * * *', undefined, 'legacy-other-jobid'))
  const q = fakeQueue(seed)
  const s = await reconciler(q).reconcileOnce()
  assert.deepEqual(q.calls.remove, [])
  assert.deepEqual(s.missing, ['email-agent-cycle'])
  assert.match(s.lastErrors.find((e) => e.name === 'email-agent-cycle')?.message ?? '', /2 identical schedules/)
})

test('a Redis flush after verification is detected by the next verification pass and repaired', async () => {
  const q = fakeQueue()
  const r = reconciler(q)
  await r.reconcileOnce()
  q.live.clear()
  const s = await r.reconcileOnce()
  assert.equal(s.ok, true)
  assert.equal(q.live.size, 12)
})

// ── Repair: a schedule that is PRESENT but no longer firing ─────────────
// BullMQ leaves the repeat entry in place when it fails to create a
// repeatable's next iteration, so the dead schedule still matches on
// name/pattern/tz. A presence-only pass was therefore a guaranteed no-op for
// the one error the scheduled worker wires requestReconcile to, and readiness
// went on reporting the cron registered. These pin the latched repair.

test('REPAIR: with all 12 already present, a forced request re-adds every schedule (a plain verification does not)', async () => {
  const q = fakeQueue(CRON_SCHEDULES.map((s) => liveEntry(s.name, s.pattern, s.tz)))
  const timers: Array<{ fn: () => void; ms: number }> = []
  const r = reconciler(q, { setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimer: () => undefined })
  r.start()
  await settle()
  assert.equal(r.status().ok, true)
  q.calls.add.length = 0

  // The 10-minute verification with everything present and no repair pending.
  assert.equal(timers.at(-1)?.ms, 600_000)
  timers.at(-1)?.fn()
  await settle()
  assert.deepEqual(q.calls.add, [], 'a routine verification must not re-add')

  // The repair the worker asks for on 'Failed to add repeatable job for next iteration'.
  r.requestReconcile(5_000, { forceReadd: true })
  assert.equal(timers.at(-1)?.ms, 5_000, 'the pass is also brought forward')
  timers.at(-1)?.fn()
  await settle()
  assert.deepEqual([...q.calls.add].sort(), [...NAMES].sort(), 'every schedule is re-armed, present or not')
  assert.equal(q.live.size, 12, 'an override re-add creates no duplicate')
  for (const n of NAMES) assert.equal([...q.live.values()].filter((e) => e.name === n).length, 1, n)
  assert.deepEqual(q.calls.remove, [])

  // The latch is taken once: the pass after the repair is quiet again.
  q.calls.add.length = 0
  timers.at(-1)?.fn()
  await settle()
  assert.deepEqual(q.calls.add, [], 'the repair is not repeated on every later pass')
})

test('REPAIR: a request arriving while a pass is in flight is honoured by the next pass, never dropped', async () => {
  const q = fakeQueue(CRON_SCHEDULES.map((s) => liveEntry(s.name, s.pattern, s.tz)))
  const timers: Array<{ fn: () => void; ms: number }> = []
  const r = reconciler(q, { setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimer: () => undefined })
  r.start()
  await settle()
  q.calls.add.length = 0

  // Park the next pass INSIDE its add, i.e. after it has taken the latch.
  const absent = CRON_SCHEDULES[5]
  q.live.delete(legacyRepeatKey(absent))
  let release: () => void = () => undefined
  const parked = new Promise<void>((res) => {
    release = res
  })
  q.gateAdd((name) => (name === absent.name ? parked : null))
  timers.at(-1)?.fn()
  await settle()
  assert.deepEqual(q.calls.add, [absent.name], 'the pass is running and has already read the latch')

  r.requestReconcile(5_000, { forceReadd: true })
  q.gateAdd(() => null)
  release()
  await settle()
  assert.deepEqual(q.calls.add, [absent.name], 'the pass already under way finishes as it was')
  assert.equal(r.status().ok, true)

  q.calls.add.length = 0
  timers.at(-1)?.fn()
  await settle()
  assert.deepEqual([...q.calls.add].sort(), [...NAMES].sort(), 'the repair survived the in-flight pass')
  assert.equal(q.live.size, 12)
})

test('REPAIR: a pass that could not verify re-arms the repair instead of consuming it', async () => {
  const q = fakeQueue(CRON_SCHEDULES.map((s) => liveEntry(s.name, s.pattern, s.tz)))
  let up = true
  const r = reconciler(q, { redisOk: async () => up })
  assert.equal((await r.reconcileOnce()).ok, true)
  q.calls.add.length = 0
  up = false
  assert.equal((await r.reconcileOnce()).ok, true, 'a failed PING is not evidence the schedules vanished')
  assert.deepEqual(q.calls.add, [], 'no queue command during an outage')
  up = true
  await r.reconcileOnce()
  assert.deepEqual([...q.calls.add].sort(), [...NAMES].sort(), 'the outage re-armed the repair; the next good pass applies it')
})

// ── The background loop ─────────────────────────────────────────────────

test('loop: quick bounded backoff while missing, slow verification once registered; stop() halts it', async () => {
  const q = fakeQueue()
  let up = false
  const timers: Array<{ fn: () => void; ms: number }> = []
  const r = reconciler(q, {
    redisOk: async () => up,
    retryMinMs: 5_000,
    retryMaxMs: 120_000,
    verifyIntervalMs: 600_000,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimer: () => undefined,
  })
  r.start()
  r.start() // idempotent
  const flush = () => new Promise((res) => setImmediate(res))
  await flush()
  await flush()
  for (let i = 0; i < 7; i++) {
    const t = timers[timers.length - 1]
    t.fn()
    await flush()
    await flush()
  }
  assert.deepEqual(timers.map((t) => t.ms), [5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 120_000, 120_000])
  assert.equal(q.totalCalls(), 0)
  up = true
  timers[timers.length - 1].fn()
  await flush()
  await flush()
  assert.equal(timers[timers.length - 1].ms, 600_000, 'registered → slow verification interval')
  assert.equal(r.status().ok, true)
  assert.ok(r.status().nextPassAt)
  const count = timers.length
  r.stop()
  timers[timers.length - 1].fn()
  await flush()
  await flush()
  assert.equal(timers.length, count, 'a stopped reconciler schedules nothing further')
})

test('requestReconcile brings the next pass forward but never pushes it later', async () => {
  const q = fakeQueue()
  const timers: number[] = []
  const r = reconciler(q, { setTimer: (_fn, ms) => (timers.push(ms), timers.length), clearTimer: () => undefined })
  r.start()
  await new Promise((res) => setImmediate(res))
  await new Promise((res) => setImmediate(res))
  assert.equal(timers.at(-1), 600_000)
  r.requestReconcile(5_000)
  assert.equal(timers.at(-1), 5_000)
  r.requestReconcile(60_000)
  assert.equal(timers.at(-1), 5_000, 'a later request does not delay the pending pass')
})

test('source: the scheduled worker registers through the reconciler and nothing exits the process for cron', () => {
  const code = (t: string) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const worker = code(readFileSync(resolve(__dirname, '../../workers/scheduled.worker.ts'), 'utf8'))
  const recon = code(readFileSync(resolve(__dirname, '../cron-schedules.ts'), 'utf8'))
  assert.match(worker, /redisOk: async \(\) => \(await pingAppRedis\(\)\)\.ok/, 'gated on the fail-fast probe')
  // FORCED, not just sooner: the repeat entry survives the failure, so a pass
  // that only looks for absent schedules repairs nothing (behaviour above).
  assert.match(worker, /Failed to add repeatable job for next iteration[\s\S]{0,200}requestReconcile\(5_000, \{ forceReadd: true \}\)/)
  assert.ok(!/upsertJobScheduler/.test(worker + recon), 'stay on the legacy repeat API')
  assert.ok(!/process\.exit/.test(recon) && !/process\.exit/.test(worker), 'a cron problem must never exit the process')
  assert.ok(!/registerCronJobs\(\)\.catch/.test(worker), 'no fire-and-forget registration')
})

// ── REDIS-GATED: real BullMQ ────────────────────────────────────────────

test('REDIS-GATED: three startups leave exactly one repeatable per managed name, and a forced re-add revives a lost iteration', { skip: redisSkip() }, async () => {
  const { Queue } = await import('bullmq')
  const { Redis } = await import('ioredis')
  const { pingRedis } = await import('../redis-health')
  const url = new URL(process.env.REDIS_TEST_URL as string)
  const connection = { host: url.hostname, port: Number(url.port || 6379), ...(url.password ? { password: decodeURIComponent(url.password) } : {}) }
  const name = `cron-reconcile-test-${randomUUID()}`
  const queue = new Queue(name, { connection })
  const probe = new Redis(process.env.REDIS_TEST_URL as string, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false })
  try {
    await probe.connect()
    const redisOk = async () => (await pingRedis(probe, 2_000)).ok
    for (let startup = 0; startup < 3; startup++) {
      const r = createCronReconciler({ queue, redisOk })
      const s = await r.reconcileOnce()
      assert.equal(s.ok, true, JSON.stringify(s.lastErrors))
      assert.deepEqual(s.registered, NAMES)
    }
    // And the old one-shot shape (a plain re-add, as a rollback would do) is override-idempotent too.
    for (const s of CRON_SCHEDULES) {
      await queue.add(s.name, { type: s.name }, { repeat: s.tz ? { pattern: s.pattern, tz: s.tz } : { pattern: s.pattern }, jobId: s.jobId })
    }
    const live = await queue.getRepeatableJobs()
    assert.equal(live.length, 12, `expected exactly 12 repeatables, got ${live.length}`)
    for (const s of CRON_SCHEDULES) {
      const mine = live.filter((j) => j.name === s.name)
      assert.equal(mine.length, 1, `exactly one repeatable for ${s.name}`)
      assert.equal(mine[0].pattern, s.pattern)
      assert.equal(mine[0].tz ?? null, s.tz ?? null)
      assert.equal(mine[0].key, legacyRepeatKey(s), 'the offline key model must match real BullMQ')
    }
    // A flushed schedule is repaired by the next pass.
    await queue.removeRepeatableByKey(legacyRepeatKey(CRON_SCHEDULES[5]))
    const healed = await createCronReconciler({ queue, redisOk }).reconcileOnce()
    assert.equal(healed.ok, true)
    assert.equal((await queue.getRepeatableJobs()).length, 12)

    // And the case a presence check cannot see: the repeat entry survives but
    // its next ITERATION is gone, exactly as when BullMQ fails to create it.
    // Only a forced re-add restores a firing schedule — and it must not leave a
    // second repeatable behind.
    const target = CRON_SCHEDULES[2] // campaign-sweep: the next run is minutes away
    const delayedFor = async () => (await queue.getDelayed()).filter((j) => j.name === target.name)
    const r = createCronReconciler({ queue, redisOk })
    await r.reconcileOnce() // consume the boot repair, so the next pass is a plain verification

    const pending = await delayedFor()
    assert.equal(pending.length, 1, 'the repeatable must have a delayed next iteration to lose')
    await pending[0].remove()
    assert.equal((await delayedFor()).length, 0, 'the schedule is now dead but still present')
    assert.equal((await queue.getRepeatableJobs()).filter((j) => j.name === target.name).length, 1)

    const unrepaired = await r.reconcileOnce()
    assert.equal(unrepaired.ok, true, 'presence still reports it registered — which is why a repair must be forced')
    assert.equal((await delayedFor()).length, 0, 'a presence-only pass cannot see or fix it')

    // requestReconcile latches before it checks whether the loop is running, so
    // a repair can be asked for without starting the background timer.
    r.requestReconcile(0, { forceReadd: true })
    const repaired = await r.reconcileOnce()
    assert.equal(repaired.ok, true, JSON.stringify(repaired.lastErrors))
    assert.equal((await delayedFor()).length, 1, 'the forced re-add recreated the next iteration')
    assert.equal((await queue.getRepeatableJobs()).filter((j) => j.name === target.name).length, 1, 'and only one repeatable for the name')
    assert.equal((await queue.getRepeatableJobs()).length, 12)
  } finally {
    for (const j of await queue.getRepeatableJobs().catch(() => [])) await queue.removeRepeatableByKey(j.key).catch(() => undefined)
    await queue.obliterate({ force: true }).catch(() => undefined)
    await queue.close().catch(() => undefined)
    probe.disconnect()
  }
})
