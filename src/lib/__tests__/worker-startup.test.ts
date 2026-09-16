// ════════════════════════════════════════════════════════════════════════
//  WORKER HOST STARTUP — visible before it can fail
//  ---------------------------------------------------------------------
//  The host used to import every worker, the bot, Prisma and Stripe statically,
//  and src/lib/redis.ts built its BullMQ connection AT IMPORT. A production
//  container with no REDIS_URL therefore died while its imports were still
//  resolving: no HTTP server, no /health, no banner naming the variable — just a
//  stack trace and a Railway crash loop. Health was no better: it answered "ok"
//  for a worker that had never connected (bullmq sets isRunning() before its
//  first connection), for a cron registration that had failed, and for a
//  database nobody had asked.
//
//  These tests pin the replacement end to end:
//    • importing redis.ts throws nothing, and the production refusal to fall
//      back to localhost still fires at FIRST USE;
//    • /livez answers while modules are still loading;
//    • missing/invalid configuration is 503 BY NAME, loads no module, and exits
//      non-zero after the grace window (the only non-zero exit this host makes);
//    • Redis, Postgres, cron and worker-attachment problems are 503 and NEVER
//      exit — Railway restarts at most ten times, and a restart cannot fix Redis;
//    • the Discord gateway bot logs in only after the workers started;
//    • the real entrypoint, in a child process with REDIS_URL scrubbed, serves
//      /livez 200 and a 503 readiness that names REDIS_URL;
//    • API readiness refuses to call email infrastructure ready with no consumer.
//  Offline: no Redis, no Postgres, no network. Fake modules and an injected exit.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Worker } from 'bullmq'

import { startWorkerHost, type WorkerHostDeps } from '../../worker-runtime/host'
import type { WorkerModules, WorkerQueueName } from '../../worker-runtime/load-modules'
import { CRON_SCHEDULES, type CronStatus } from '../cron-schedules'
import {
  createErrorLogLimiter,
  evaluateEmailDelivery,
  singleFlightCache,
  SCHEDULE_BOOT_GRACE_MS,
  type QueueWorkerCounts,
} from '../worker-health'
import { assertNoProductionCredentials } from './_disposable-test-env'

assertNoProductionCredentials()

const REPO = resolve(__dirname, '../../..')
const readSrc = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8')

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Poll until `fn` returns truthy, or fail with a readable reason. */
async function until<T>(what: string, fn: () => T | Promise<T>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
    await wait(20)
  }
}

type Json = Record<string, unknown>
const problemsOf = (body: Json): string[] => (body.problems as string[] | undefined) ?? []
const hasProblem = (body: Json, re: RegExp) => problemsOf(body).some((p) => re.test(p))

async function getJson(url: string): Promise<{ status: number; body: Json }> {
  const res = await fetch(url)
  return { status: res.status, body: (await res.json()) as Json }
}

// ── Fakes ───────────────────────────────────────────────────────────────

type FakeWorker = EventEmitter & { isRunning(): boolean; isPaused(): boolean; close(): Promise<void>; closed: boolean }

function fakeWorker(o: { running?: boolean; paused?: boolean } = {}): FakeWorker {
  const w = new EventEmitter() as FakeWorker
  w.closed = false
  w.isRunning = () => o.running ?? true
  w.isPaused = () => o.paused ?? false
  w.close = async () => {
    w.closed = true
  }
  return w
}

const QUEUES: WorkerQueueName[] = ['email', 'discord', 'scheduled', 'marketing', 'webhook-retry']

function cronStatus(over: Partial<CronStatus> = {}): CronStatus {
  const at = new Date(1_700_000_000_000).toISOString()
  return {
    ok: true,
    firstPassDone: true,
    startedAt: at,
    lastPassAt: at,
    lastOkAt: at,
    nextPassAt: null,
    expected: CRON_SCHEDULES.length,
    registered: CRON_SCHEDULES.map((s) => s.name),
    missing: [],
    lastErrors: [],
    ...over,
  }
}

type FakeModuleOptions = {
  /** Queues whose worker emits 'ready' (default: all of them). */
  attach?: WorkerQueueName[]
  running?: Partial<Record<WorkerQueueName, boolean>>
  paused?: Partial<Record<WorkerQueueName, boolean>>
  /** undefined = healthy; null = the scheduled worker never started. */
  cron?: CronStatus | null
  db?: () => Promise<void>
  startThrows?: WorkerQueueName
}

function fakeModules(opts: FakeModuleOptions = {}) {
  const events: string[] = []
  const workers = new Map<WorkerQueueName, FakeWorker>()
  let dbCalls = 0
  const mods: WorkerModules = {
    starters: QUEUES.map((name) => ({
      name,
      start: () => {
        events.push(`start:${name}`)
        if (opts.startThrows === name) throw new Error('worker constructor failed')
        const w = fakeWorker({ running: opts.running?.[name], paused: opts.paused?.[name] })
        workers.set(name, w)
        // bullmq emits 'ready' from its blocking connection, asynchronously —
        // the host attaches its listener synchronously after start() returns.
        if (!opts.attach || opts.attach.includes(name)) setTimeout(() => w.emit('ready'), 0)
        return w as unknown as Worker
      },
    })),
    getCronStatus: () => (opts.cron === undefined ? cronStatus() : opts.cron),
    stopCronJobs: () => {
      events.push('stopCron')
    },
    getDiscordClient: () => {
      events.push('discordLogin')
      return { isReady: () => true }
    },
    processStripeWebhook: async () => ({ status: 200, body: { received: true } }),
    probeDb: async () => {
      dbCalls++
      if (opts.db) await opts.db()
    },
    disconnectDb: async () => {
      events.push('disconnectDb')
    },
    blockRecordFailureStats: () => ({ total: 0 }),
  }
  return { mods, events, workers, dbCalls: () => dbCalls }
}

function startHost(over: Partial<WorkerHostDeps> = {}) {
  const exits: number[] = []
  let resolveExit: ((code: number) => void) | null = null
  const firstExit = new Promise<number>((r) => {
    resolveExit = r
  })
  const host = startWorkerHost({
    port: 0,
    hostname: '127.0.0.1',
    validateConfig: () => ({ ok: true, missing: [], invalid: [] }),
    pingRedis: async () => ({ ok: true, latencyMs: 1, error: null }),
    exit: (code) => {
      exits.push(code)
      resolveExit?.(code)
    },
    configFailureExitMs: 60,
    ...over,
  })
  return { host, exits, firstExit, base: async () => `http://127.0.0.1:${await host.listening}` }
}

// ════════════════════════════════════════════════════════════════════════
//  1. Nothing may throw while the imports are still resolving
// ════════════════════════════════════════════════════════════════════════

test('importing src/lib/redis.ts in production without REDIS_URL does not throw; the refusal moves to first use', async () => {
  // NODE_ENV is declared read-only by the Next.js types; this test has to run
  // the module under the production rule, so mutate through a writable alias.
  const env = process.env as Record<string, string | undefined>
  const prevNodeEnv = env.NODE_ENV
  const prevRedisUrl = env.REDIS_URL
  try {
    env.NODE_ENV = 'production'
    delete env.REDIS_URL
    // The module body runs here. Before 2026-09-15 it ended with
    // `export const bullConnection = getBullConnection()` and threw right here,
    // killing the worker host before its HTTP server existed.
    const redis = await import('../redis')
    redis.__resetBullConnectionForTests()

    assert.throws(
      () => redis.getLazyBullConnection(),
      /REDIS_URL is not set[\s\S]*Refusing to fall back to localhost/,
      'production must still refuse to fall back to localhost — at first use'
    )
    // Not cached as a failure: a later call must throw the same refusal, never
    // hand back a localhost config.
    assert.throws(() => redis.getLazyBullConnection(), /REDIS_URL is not set/)
    assert.equal(redis.redisConfigProblem(), 'REDIS_URL is not set')

    env.REDIS_URL = 'redis://127.0.0.1:6379'
    redis.__resetBullConnectionForTests()
    const conn = redis.getLazyBullConnection() as { host?: string; port?: number }
    assert.equal(conn.host, '127.0.0.1')
    assert.equal(conn.port, 6379)
    assert.equal(redis.redisConfigProblem(), null)

    assert.equal(redisProblem({ REDIS_URL: 'not a url', NODE_ENV: 'production' }), 'REDIS_URL is not a valid URL')
    assert.equal(redisProblem({ REDIS_URL: 'http://h:6379', NODE_ENV: 'production' }), 'REDIS_URL must use redis:// or rediss://')
    assert.equal(redisProblem({ NODE_ENV: 'development' }), null, 'outside production the localhost default is legitimate')

    function redisProblem(env: NodeJS.ProcessEnv): string | null {
      return redis.redisConfigProblem(env)
    }
  } finally {
    if (prevNodeEnv === undefined) delete env.NODE_ENV
    else env.NODE_ENV = prevNodeEnv
    if (prevRedisUrl === undefined) delete env.REDIS_URL
    else env.REDIS_URL = prevRedisUrl
    const redis = await import('../redis')
    redis.__resetBullConnectionForTests()
  }
})

test('no module builds a BullMQ connection at import time (the eager `bullConnection` export is gone)', () => {
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue
      // Anchored at column 0 so the comment in redis.ts explaining why the
      // eager export was removed does not read as the export itself.
      const src = readFileSync(full, 'utf8')
      if (/^export const bullConnection/m.test(src)) offenders.push(`${full}: exports an eager bullConnection`)
      if (/^import\s*\{[^}]*\bbullConnection\b[^}]*\}\s*from/m.test(src)) offenders.push(`${full}: imports the eager bullConnection`)
    }
  }
  walk(resolve(REPO, 'src'))
  walk(resolve(REPO, 'scripts'))
  assert.deepEqual(offenders, [], 'every consumer must call getLazyBullConnection() inside its start function')
})

test('the worker host entrypoint imports nothing that can throw at import, and loads the workers by literal specifier', () => {
  const entry = readSrc('src/worker-host.ts')
  const statics = [...entry.matchAll(/^import .*from '([^']+)'/gm)].map((m) => m[1])
  for (const spec of statics) {
    assert.ok(
      !/workers\/|bot\/|stripe-events|lib\/db|email-guard|lib\/queues/.test(spec),
      `worker-host.ts must not statically import ${spec} — a throw there happens before the HTTP server exists`
    )
  }
  const host = readSrc('src/worker-runtime/host.ts')
  assert.ok(/await listening[\s\S]{0,800}d\.validateConfig\(\)/.test(host), 'the HTTP server must bind before configuration is validated')
  assert.ok(host.indexOf('d.validateConfig()') < host.indexOf('d.loadModules()'), 'configuration is validated before any module is loaded')
  const load = readSrc('src/worker-runtime/load-modules.ts')
  for (const spec of ['../workers/email.worker', '../workers/discord.worker', '../workers/scheduled.worker', '../workers/marketing.worker', '../workers/webhook.worker', '../bot/discord-actions']) {
    assert.ok(load.includes(`import('${spec}')`), `load-modules must use the LITERAL specifier import('${spec}') (the env-ownership scanner follows literals)`)
  }
})

test('importing the Discord actions module no longer logs the gateway bot in', () => {
  const src = readSrc('src/bot/discord-actions.ts')
  assert.ok(!/^getDiscordClient\(\)/m.test(src), 'a top-level getDiscordClient() logs the bot in during import, before configuration is validated')
  const host = readSrc('src/worker-runtime/host.ts')
  assert.ok(
    host.indexOf('starter.start()') < host.indexOf('mods.getDiscordClient()'),
    'the host starts the queue workers before it logs the bot in'
  )
})

// ════════════════════════════════════════════════════════════════════════
//  2. The startup sequence
// ════════════════════════════════════════════════════════════════════════

test('/livez answers while the modules are still loading, and readiness says the host is not running yet', async () => {
  const { host, exits } = startHost({ loadModules: () => new Promise<WorkerModules>(() => undefined) })
  try {
    const base = `http://127.0.0.1:${await host.listening}`
    await until('phase loading', () => host.phase() === 'loading')

    const live = await getJson(`${base}/livez`)
    assert.equal(live.status, 200)
    assert.equal(live.body.status, 'alive')
    assert.equal(live.body.phase, 'loading')

    const ready = await getJson(`${base}/readyz`)
    assert.equal(ready.status, 503)
    assert.ok(hasProblem(ready.body, /not running \(phase: loading\)/))

    // Stripe must retry rather than believe a 2xx from a host that cannot process.
    const hook = await fetch(`${base}/api/stripe/webhook`, { method: 'POST', body: 'x' })
    assert.equal(hook.status, 503)
    assert.deepEqual(await hook.json(), { error: 'starting' })

    assert.deepEqual(exits, [], 'a slow module load must not exit the process')
  } finally {
    await host.shutdown('test')
  }
})

test('missing configuration: 503 by NAME, no module is loaded, and the process exits non-zero after the grace window', async () => {
  const canary = 'canary-value-must-never-be-echoed'
  const prev = process.env.WORKER_HOST_TEST_CANARY
  process.env.WORKER_HOST_TEST_CANARY = canary
  let loaded = 0
  const { host, firstExit, exits } = startHost({
    validateConfig: () => ({ ok: false, missing: ['REDIS_URL', 'RESEND_API_KEY'], invalid: [] }),
    loadModules: async () => {
      loaded++
      return fakeModules().mods
    },
    configFailureExitMs: 60,
  })
  try {
    const base = `http://127.0.0.1:${await host.listening}`
    await host.booted
    assert.equal(loaded, 0, 'no worker module may be constructed with a configuration the host rejected')
    assert.equal(host.phase(), 'config_failed')

    const ready = await getJson(`${base}/readyz`)
    assert.equal(ready.status, 503)
    assert.equal(ready.body.status, 'degraded')
    assert.deepEqual(ready.body.envMissing, ['REDIS_URL', 'RESEND_API_KEY'])
    assert.ok(hasProblem(ready.body, /missing configuration: .*REDIS_URL/))
    assert.ok(hasProblem(ready.body, /RESEND_API_KEY/))
    assert.ok(typeof ready.body.exitAt === 'string', 'the body says when the process will exit')
    assert.ok(!JSON.stringify(ready.body).includes(canary), 'health bodies report names, never values')

    // /livez keeps answering: the container is alive, it just cannot work.
    assert.equal((await getJson(`${base}/livez`)).status, 200)

    const code = await Promise.race([firstExit, wait(3_000).then(() => -1)])
    assert.equal(code, 1, 'a fatal configuration failure must exit non-zero so the deployment shows as crashed')
    assert.deepEqual(exits, [1])
  } finally {
    if (prev === undefined) delete process.env.WORKER_HOST_TEST_CANARY
    else process.env.WORKER_HOST_TEST_CANARY = prev
    await host.shutdown('test')
  }
})

test('an unusable REDIS_URL is a configuration failure, and no Redis probe is built from it', async () => {
  let pings = 0
  const { host, firstExit } = startHost({
    validateConfig: () => ({ ok: false, missing: [], invalid: ['REDIS_URL is not a valid URL'] }),
    pingRedis: async () => {
      pings++
      return { ok: false, latencyMs: null, error: 'should not be asked' }
    },
    configFailureExitMs: 60,
  })
  try {
    await host.booted
    const ready = await host.readiness()
    assert.equal(ready.httpStatus, 503)
    assert.ok(hasProblem(ready.body, /invalid configuration: REDIS_URL is not a valid URL/))
    assert.equal(ready.body.redis, null)
    assert.equal(pings, 0, 'an unparseable URL is already named; do not try to connect with it')
    assert.equal(await Promise.race([firstExit, wait(3_000).then(() => -1)]), 1)
  } finally {
    await host.shutdown('test')
  }
})

test('a module that fails to load halts startup with a sanitized reason and exits non-zero', async () => {
  const { host, firstExit } = startHost({
    loadModules: async () => {
      throw new Error('cannot reach redis://default:hunter2@redis.internal:6379 during import')
    },
    configFailureExitMs: 60,
  })
  try {
    await host.booted
    assert.equal(host.phase(), 'load_failed')
    const ready = await host.readiness()
    assert.equal(ready.httpStatus, 503)
    const fatal = String(ready.body.fatal)
    assert.ok(fatal.length > 0, 'the reason is reported')
    assert.ok(!fatal.includes('hunter2'), 'a credential in an error message must never reach the health body')
    assert.equal(await Promise.race([firstExit, wait(3_000).then(() => -1)]), 1)
  } finally {
    await host.shutdown('test')
  }
})

test('everything healthy: /readyz, /healthz, /health and / all answer 200, and the bot logs in only after the workers started', async () => {
  const f = fakeModules()
  const { host, exits } = startHost({ loadModules: async () => f.mods })
  try {
    const base = `http://127.0.0.1:${await host.listening}`
    await host.booted
    await until('every worker attached', async () => (await host.readiness()).httpStatus === 200)

    for (const path of ['/readyz', '/healthz', '/health', '/']) {
      const res = await getJson(`${base}${path}`)
      assert.equal(res.status, 200, `${path} must answer 200 when everything is healthy`)
      assert.equal(res.body.status, 'ok')
      assert.deepEqual(res.body.problems, [])
      assert.equal(res.body.phase, 'running')
    }

    const body = (await getJson(`${base}/readyz`)).body
    const workers = body.workers as Array<{ name: string; attached: boolean; running: boolean }>
    assert.deepEqual(workers.map((w) => w.name), QUEUES)
    assert.ok(workers.every((w) => w.attached && w.running))
    assert.equal((body.schedules as CronStatus).missing.length, 0)
    assert.equal((body.db as { ok: boolean }).ok, true)

    assert.deepEqual(
      f.events,
      [...QUEUES.map((q) => `start:${q}`), 'discordLogin'],
      'the gateway bot must log in last — never for a host whose workers never started'
    )
    assert.deepEqual(exits, [], 'a healthy host never exits')
  } finally {
    await host.shutdown('test')
  }
})

test('a worker that is running but never connected is NOT ready (bullmq sets isRunning() before connecting)', async () => {
  const f = fakeModules({ attach: ['email', 'discord', 'scheduled', 'marketing'] })
  const { host } = startHost({ loadModules: async () => f.mods })
  try {
    await host.booted
    await wait(30)
    const ready = await host.readiness()
    assert.equal(ready.httpStatus, 503)
    assert.ok(hasProblem(ready.body, /queue worker "webhook-retry" has not connected to Redis/))
  } finally {
    await host.shutdown('test')
  }
})

test('a worker that stopped or was paused is named, and a constructor that threw leaves the others running', async () => {
  const stopped = fakeModules({ running: { email: false }, paused: { marketing: true } })
  const a = startHost({ loadModules: async () => stopped.mods })
  try {
    await a.host.booted
    await wait(30)
    const ready = await a.host.readiness()
    assert.equal(ready.httpStatus, 503)
    assert.ok(hasProblem(ready.body, /queue worker "email" is not running/))
    assert.ok(hasProblem(ready.body, /queue worker "marketing" is paused/))
  } finally {
    await a.host.shutdown('test')
  }

  const broken = fakeModules({ startThrows: 'discord' })
  const b = startHost({ loadModules: async () => broken.mods })
  try {
    await b.host.booted
    await wait(30)
    const ready = await b.host.readiness()
    assert.equal(ready.httpStatus, 503)
    assert.ok(hasProblem(ready.body, /queue worker "discord"/))
    assert.deepEqual(
      broken.events.filter((e) => e.startsWith('start:')),
      QUEUES.map((q) => `start:${q}`),
      'one failing constructor must not stop the remaining workers being started'
    )
    assert.deepEqual(b.exits, [], 'a failed worker constructor is reported, not a process exit')
  } finally {
    await b.host.shutdown('test')
  }
})

test('Redis, Postgres and cron problems are 503 and NEVER exit the process', async () => {
  // A restart cannot fix Redis, and Railway gives up after ten of them: an exit
  // here would end with transactional email permanently down.
  const f = fakeModules({ cron: cronStatus({ ok: false, missing: ['campaign-sweep', 'outbox-email-recovery'], lastErrors: [{ name: 'campaign-sweep', message: 'redis did not answer PING' }] }) })
  const { host, exits } = startHost({
    loadModules: async () => f.mods,
    pingRedis: async () => ({ ok: false, latencyMs: null, error: 'connection refused' }),
    configFailureExitMs: 40,
  })
  try {
    await host.booted
    await wait(30)
    const ready = await host.readiness()
    assert.equal(ready.httpStatus, 503)
    assert.ok(hasProblem(ready.body, /redis did not answer PING/))
    assert.ok(hasProblem(ready.body, /recurring schedule "campaign-sweep" is not registered/))
    assert.ok(hasProblem(ready.body, /recurring schedule "outbox-email-recovery" is not registered/))
    await wait(120)
    assert.deepEqual(exits, [], 'cron and Redis problems must never exit the worker host')
    assert.equal(host.phase(), 'running', 'the email worker keeps processing while a schedule is missing')
  } finally {
    await host.shutdown('test')
  }
})

test('a schedule that has not been verified yet is tolerated during the boot grace window, then reported', async () => {
  let clock = 1_700_000_000_000
  const f = fakeModules({ cron: cronStatus({ ok: false, firstPassDone: false, lastPassAt: null, registered: [], missing: CRON_SCHEDULES.map((s) => s.name) }) })
  const { host } = startHost({ loadModules: async () => f.mods, now: () => clock })
  try {
    await host.booted
    await wait(30)
    assert.equal((await host.readiness()).httpStatus, 200, 'a first reconcile pass in flight is not yet a problem')
    clock += SCHEDULE_BOOT_GRACE_MS + 1
    const late = await host.readiness()
    assert.equal(late.httpStatus, 503)
    assert.ok(hasProblem(late.body, /recurring schedules not yet verified/))
  } finally {
    await host.shutdown('test')
  }
})

test('a database that does not answer is 503 but not fatal, and the check is bounded and cached', async () => {
  const slow = fakeModules({ db: () => new Promise<void>(() => undefined) })
  const a = startHost({ loadModules: async () => slow.mods, dbTimeoutMs: 30, dbCacheMs: 10_000 })
  try {
    await a.host.booted
    await wait(30)
    const ready = await a.host.readiness()
    assert.equal(ready.httpStatus, 503)
    assert.ok(hasProblem(ready.body, /database did not answer SELECT 1/))
    assert.equal((ready.body.db as { ok: boolean }).ok, false)
    assert.equal(a.host.phase(), 'running', 'Postgres being slow is not a startup failure — BullMQ retries jobs')
    await a.host.readiness()
    await a.host.readiness()
    assert.equal(slow.dbCalls(), 1, 'a polled readiness endpoint must not multiply Postgres wakeups (Neon bills compute)')
    assert.deepEqual(a.exits, [], 'a database problem must not exit the host')
  } finally {
    await a.host.shutdown('test')
  }

  let failures = 1
  const flaky = fakeModules({
    db: async () => {
      if (failures-- > 0) throw new Error('connection to postgresql://u:pw@db.example/neondb refused')
    },
  })
  let clock = 1_700_000_000_000
  const b = startHost({ loadModules: async () => flaky.mods, dbCacheMs: 1_000, now: () => clock })
  try {
    await b.host.booted
    await wait(30)
    const first = await b.host.readiness()
    assert.equal(first.httpStatus, 503)
    assert.ok(!JSON.stringify(first.body).includes('pw@'), 'a connection string in the error must be sanitized out')
    clock += 2_000
    await until('the database probe to recover', async () => (await b.host.readiness()).httpStatus === 200)
  } finally {
    await b.host.shutdown('test')
  }
})

test('a Stripe webhook is delegated once the host is running', async () => {
  const f = fakeModules()
  const { host } = startHost({ loadModules: async () => f.mods })
  try {
    const base = `http://127.0.0.1:${await host.listening}`
    await host.booted
    const res = await fetch(`${base}/api/stripe/webhook`, { method: 'POST', body: 'raw-bytes' })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { received: true })
  } finally {
    await host.shutdown('test')
  }
})

test('shutdown stops the cron loop, closes every worker so an in-flight send finishes, disconnects Postgres and exits', async () => {
  const f = fakeModules()
  const { host, exits } = startHost({ loadModules: async () => f.mods })
  await host.booted
  await host.shutdown('SIGTERM')
  assert.ok(f.events.includes('stopCron'), 'the background reconcile loop is stopped')
  assert.ok([...f.workers.values()].every((w) => w.closed), 'worker.close() waits for active jobs — killing one mid-send re-runs it as stalled')
  assert.ok(f.events.includes('disconnectDb'))
  assert.deepEqual(exits, [0])
  assert.equal(host.phase(), 'stopping')
})

test('a worker "error" event is recorded, never thrown, and rate-limited so a Redis outage cannot flood the log', async () => {
  const f = fakeModules()
  const { host } = startHost({ loadModules: async () => f.mods })
  try {
    await host.booted
    await wait(30)
    const email = f.workers.get('email')
    assert.ok(email)
    for (let i = 0; i < 50; i++) email.emit('error', new Error('connect ECONNREFUSED redis://default:hunter2@127.0.0.1:6379'))
    const ready = await host.readiness()
    const workers = ready.body.workers as Array<{ name: string; lastError: string | null }>
    const last = workers.find((w) => w.name === 'email')?.lastError ?? ''
    assert.ok(/ECONNREFUSED/.test(last), 'the last error is reported')
    assert.ok(!last.includes('hunter2'), 'and it is sanitized')
  } finally {
    await host.shutdown('test')
  }

  // The limiter itself: one line per distinct message per window, with a count.
  let clock = 0
  const limiter = createErrorLogLimiter(60_000, 200, () => clock)
  assert.deepEqual(limiter('email connect ECONNREFUSED'), { log: true, suppressed: 0 })
  for (let i = 0; i < 99; i++) limiter('email connect ECONNREFUSED')
  assert.equal(limiter('email connect ECONNREFUSED').log, false)
  assert.deepEqual(limiter('discord other failure'), { log: true, suppressed: 0 }, 'a different message is not suppressed')
  clock += 60_001
  const afterWindow = limiter('email connect ECONNREFUSED')
  assert.equal(afterWindow.log, true)
  assert.ok(afterWindow.suppressed >= 100, 'the next line says how many were suppressed')
})

// ════════════════════════════════════════════════════════════════════════
//  3. The real entrypoint, in a child process, with REDIS_URL scrubbed
// ════════════════════════════════════════════════════════════════════════

test('the real worker host serves /livez and a 503 readiness naming REDIS_URL when it is missing', async () => {
  const canary = 'child-canary-must-never-be-echoed'
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: '0',
    // Never let a developer's .env put REDIS_URL back: dotenv/config reads this.
    DOTENV_CONFIG_PATH: resolve(REPO, 'no-such-env-file.env'),
    WORKER_CONFIG_FAILURE_EXIT_MS: '120000',
    WORKER_HOST_TEST_CANARY: canary,
  }
  delete env.REDIS_URL
  delete env.REDIS_TEST_URL
  delete env.DATABASE_URL
  delete env.RESEND_API_KEY

  const child = spawn(process.execPath, ['--import', 'tsx', resolve(REPO, 'src/worker-host.ts')], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (b: Buffer) => {
    out += b.toString()
  })
  child.stderr.on('data', (b: Buffer) => {
    out += b.toString()
  })
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))

  try {
    const port = await until(
      `the child host to report its port (output so far: ${out.slice(-400)})`,
      () => {
        if (out.includes('Error')) {
          const early = out
          if (/Cannot find|SyntaxError/.test(early)) throw new Error(`worker host failed to start: ${early.slice(0, 600)}`)
        }
        const m = /listening on port (\d+)/.exec(out)
        return m ? Number(m[1]) : 0
      },
      30_000
    )
    const base = `http://127.0.0.1:${port}`

    const live = await getJson(`${base}/livez`)
    assert.equal(live.status, 200, 'liveness answers even though the configuration was rejected')
    assert.equal(live.body.status, 'alive')

    const ready = await getJson(`${base}/readyz`)
    assert.equal(ready.status, 503, 'a host with no REDIS_URL is not ready')
    assert.ok(
      problemsOf(ready.body).join(' ').includes('REDIS_URL'),
      `readiness must name the missing variable, got: ${JSON.stringify(ready.body.problems)}`
    )
    assert.equal(ready.body.bullWorkers, 0, 'no worker may be started with a rejected configuration')
    assert.ok(!JSON.stringify(ready.body).includes(canary), 'names and reasons only — never values')
    assert.ok(/STARTUP HALTED/.test(out), 'the banner naming the missing variables is logged on every boot')
  } finally {
    child.kill()
    const hardKill = setTimeout(() => child.kill('SIGKILL'), 3_000)
    hardKill.unref?.()
    await Promise.race([exited, wait(5_000)])
    clearTimeout(hardKill)
  }
})

// ════════════════════════════════════════════════════════════════════════
//  4. API readiness — email infrastructure with no consumer is not "ok"
// ════════════════════════════════════════════════════════════════════════

const counts = (over: Partial<QueueWorkerCounts> = {}): QueueWorkerCounts => ({
  email: 1,
  scheduled: 1,
  'webhook-retry': 1,
  discord: 1,
  ...over,
})

test('API email delivery: a required queue with no worker attached is NOT ready', () => {
  assert.equal(evaluateEmailDelivery(counts()).ready, true)

  const noEmail = evaluateEmailDelivery(counts({ email: 0 }))
  assert.equal(noEmail.ready, false)
  assert.ok(noEmail.problems.some((p) => /"email"[\s\S]*will not be sent/.test(p)))

  const noScheduled = evaluateEmailDelivery(counts({ scheduled: 0 }))
  assert.equal(noScheduled.ready, false, 'the outbox drains and recovery sweeps run on the scheduled queue')

  const noWebhook = evaluateEmailDelivery(counts({ 'webhook-retry': 0 }))
  assert.equal(noWebhook.ready, false, 'paid deposits are fulfilled on the webhook-retry queue')

  const unknown = evaluateEmailDelivery(counts({ email: null }))
  assert.equal(unknown.ready, false)
  assert.ok(unknown.problems.some((p) => /unknown/.test(p)), 'a timed-out count is not evidence of a consumer')

  const noDiscord = evaluateEmailDelivery(counts({ discord: 0 }))
  assert.equal(noDiscord.ready, true, 'cards have a REST fallback: informational only')
  assert.ok(noDiscord.notes.some((n) => /discord/.test(n)))
})

test('API health reports email delivery in its status, and /api/health/live stays pure liveness', () => {
  const route = readSrc('app/api/health/route.ts')
  assert.ok(/const ok = db === 'connected' && redis\.ok/.test(route), 'the existing API dependencies still decide readiness')
  assert.ok(/&& emailDelivery\.ready/.test(route), 'a required queue with no consumer must degrade API readiness')
  assert.ok(/status: ok \? 200 : 503/.test(route), 'and the HTTP code with it')
  assert.ok(/singleFlightCache\(loadQueueWorkers, WORKER_COUNT_TTL_MS/.test(route), 'CLIENT LIST runs on Redis’s main thread: cache it')
  assert.ok(/WORKER_COUNT_UNKNOWN_TTL_MS/.test(route), 'but a window that answered nothing is retried quickly, not pinned at 503')
  assert.ok(/redis\.ok \? await queueWorkers\(\)/.test(route), 'worker counts are not asked while Redis is down')

  const live = readSrc('app/api/health/live/route.ts')
  assert.ok(/status: 200/.test(live), 'liveness is always 200 when the process serves')
  assert.ok(!/prisma|pingAppRedis|@\/lib\/queues/.test(live), 'liveness must do no I/O — it is polled')
})

test('the worker-count cache is single-flight and does not cache a failure', async () => {
  let clock = 0
  let calls = 0
  let fail = true
  const load = async () => {
    calls++
    await wait(5)
    if (fail) throw new Error('redis unreachable')
    return counts()
  }
  const cached = singleFlightCache(load, 10_000, () => clock)

  await assert.rejects(Promise.all([cached(), cached()]), /redis unreachable/)
  assert.equal(calls, 1, 'concurrent callers share one in-flight load')

  fail = false
  const [a, b] = await Promise.all([cached(), cached()])
  assert.deepEqual(a, b)
  assert.equal(calls, 2, 'a rejection is never cached')

  await cached()
  assert.equal(calls, 2, 'a good value is served from the cache inside the window')
  clock += 10_001
  await cached()
  assert.equal(calls, 3, 'and re-read after it')
})

test('singleFlightCache: an UNKNOWN value can be given a shorter lifetime than a known one', async () => {
  // The health route uses this so one slow CLIENT LIST cannot pin readiness at
  // 503 for the full ten seconds after Redis has recovered.
  let clock = 1_000_000
  let calls = 0
  let value: number | null = null
  const cached = singleFlightCache(
    async () => {
      calls++
      return value
    },
    10_000,
    () => clock,
    (v) => (v === null ? 1_000 : 10_000),
  )

  assert.equal(await cached(), null)
  assert.equal(calls, 1)
  clock += 1_001
  value = 7
  assert.equal(await cached(), 7, 'the unknown window expired after its short TTL')
  assert.equal(calls, 2)

  clock += 1_001
  value = 9
  assert.equal(await cached(), 7, 'a KNOWN value keeps the full TTL')
  assert.equal(calls, 2)
  clock += 9_000
  assert.equal(await cached(), 9)
  assert.equal(calls, 3)
})
