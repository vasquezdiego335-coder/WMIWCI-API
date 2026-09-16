import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pingRedis, sanitizeRedisError } from '../redis-health'
import { evaluateWorkerHealth } from '../worker-health'
import {
  assertNoProductionCredentials,
  assertTestRecipient,
  looksLikeProductionUrl,
  looksLikeRealResendKey,
  redisSkip,
} from './_disposable-test-env'

// ════════════════════════════════════════════════════════════════════════
//  HEALTH THAT MEANS SOMETHING, and TESTS THAT CANNOT TOUCH PRODUCTION
//  ---------------------------------------------------------------------
//  1. The worker's /health reported `redis: true` when REDIS_URL merely
//     existed. It now PINGs, and health requires every queue worker running.
//  2. A startup configuration failure left a live process that did nothing.
//  3. DB/Redis-gated suites decided from a variable being SET, not from where
//     it pointed; the shared guard now refuses production-looking targets.
// ════════════════════════════════════════════════════════════════════════

assertNoProductionCredentials()

// ── Redis ping ──────────────────────────────────────────────────────────

test('PONG within the timeout is healthy', async () => {
  const r = await pingRedis({ ping: async () => 'PONG' }, 500)
  assert.equal(r.ok, true)
  assert.equal(r.error, null)
  assert.ok((r.latencyMs ?? -1) >= 0)
})

test('a rejected PING is unhealthy and the error carries no credential', async () => {
  const r = await pingRedis(
    { ping: async () => { throw new Error('connect ECONNREFUSED redis://default:hunter2@example-proxy.proxy.rlwy.net:12345') } },
    500
  )
  assert.equal(r.ok, false)
  assert.ok(r.error && !r.error.includes('hunter2') && !r.error.includes('rlwy.net'), `leaked: ${r.error}`)
})

test('a PING that never answers times out instead of hanging the health endpoint', async () => {
  const started = Date.now()
  const r = await pingRedis({ ping: () => new Promise<string>(() => undefined) }, 150)
  assert.equal(r.ok, false)
  assert.ok(Date.now() - started < 1_000, 'must return promptly')
  assert.match(r.error ?? '', /no PONG/)
})

test('an unexpected reply is not PONG', async () => {
  const r = await pingRedis({ ping: async () => 'LOADING' }, 500)
  assert.equal(r.ok, false)
})

test('sanitizeRedisError strips URLs and auth fragments', () => {
  const s = sanitizeRedisError('WRONGPASS password=abc123 at rediss://user:pw@host:6379/0 token: xyz')
  assert.ok(!/abc123|pw@|xyz/.test(s), s)
})

test('REDIS-GATED: a real disposable Redis answers the probe PING', { skip: redisSkip() }, async () => {
  const { Redis } = await import('ioredis')
  const client = new Redis(process.env.REDIS_TEST_URL as string, { lazyConnect: true, maxRetriesPerRequest: 1 })
  try {
    await client.connect()
    const r = await pingRedis(client, 2_000)
    assert.equal(r.ok, true)
  } finally {
    client.disconnect()
  }
})

// ── Worker health verdict ───────────────────────────────────────────────

const allRunning = ['email', 'discord', 'scheduled', 'marketing', 'webhook-retry'].map((name) => ({ name, running: true, paused: false }))

test('all observations good → ok', () => {
  const v = evaluateWorkerHealth({ envMissing: [], redis: { ok: true }, workers: allRunning, expectedWorkers: 5 })
  assert.deepEqual(v, { ok: true, problems: [] })
})

test('REDIS_URL present but PING failing → degraded (the old "redis: true" lie)', () => {
  const v = evaluateWorkerHealth({ envMissing: [], redis: { ok: false }, workers: allRunning, expectedWorkers: 5 })
  assert.equal(v.ok, false)
  assert.ok(v.problems.some((p) => /PING/.test(p)))
})

test('a stopped or paused worker → degraded, naming the queue', () => {
  const workers = allRunning.map((w) => (w.name === 'email' ? { ...w, running: false } : w.name === 'scheduled' ? { ...w, paused: true } : w))
  const v = evaluateWorkerHealth({ envMissing: [], redis: { ok: true }, workers, expectedWorkers: 5 })
  assert.equal(v.ok, false)
  assert.ok(v.problems.some((p) => p.includes('"email"')))
  assert.ok(v.problems.some((p) => p.includes('"scheduled"')))
})

test('missing configuration → degraded and names the variables, never values', () => {
  const v = evaluateWorkerHealth({ envMissing: ['RESEND_API_KEY'], redis: null, workers: [], expectedWorkers: 5 })
  assert.equal(v.ok, false)
  assert.ok(v.problems.some((p) => p.includes('RESEND_API_KEY')))
})

test('fewer workers than expected → degraded', () => {
  const v = evaluateWorkerHealth({ envMissing: [], redis: { ok: true }, workers: allRunning.slice(0, 3), expectedWorkers: 5 })
  assert.equal(v.ok, false)
})

test('worker host: health PINGs Redis, reports attachment, and a config failure exits non-zero after a grace window', () => {
  // 2026-09-15: worker-host.ts is a thin entry; the host lives in worker-runtime/.
  // Behaviour (503 bodies, exit(1) after the grace window, no exit for cron or
  // Redis problems) is pinned end-to-end in worker-startup.test.ts.
  const entry = readFileSync(resolve(__dirname, '../../worker-host.ts'), 'utf8')
  const host = readFileSync(resolve(__dirname, '../../worker-runtime/host.ts'), 'utf8')
  const src = entry + host
  assert.ok(host.includes('pingRedis: () => pingAppRedis()') && host.includes('await d.pingRedis()'), '/readyz must PING Redis')
  assert.ok(/w\.isRunning\(\)/.test(src) && /w\.isPaused\(\)/.test(src), '/readyz must ask each worker whether it is running')
  assert.ok(/w\.on\('ready'/.test(host) && /attached: a\.attachedAt !== null/.test(host), "/readyz must count a worker attached only after its 'ready' event")
  assert.ok(!/state\.redis = true/.test(src), 'redis health must never be set from REDIS_URL presence')
  assert.ok(/setPhase\('config_failed'\)\s*\r?\n\s*scheduleFatalExit\(/.test(host) && /STARTUP HALTED/.test(host), 'missing configuration must schedule the fatal exit and say so')
  assert.ok(/function scheduleFatalExit[\s\S]{0,600}void shutdown\(reason, 1\)/.test(host), 'the fatal exit goes through graceful shutdown with code 1')
  assert.ok(/d\.exit\(code\)/.test(host) && /exit: \(code\) => process\.exit\(code\)/.test(host), 'and shutdown really exits the process')
  assert.ok(!/startSmsWorker/.test(src), 'no SMS worker: Move It Clear It no longer sends SMS')
})

test('the Redis probe imports ioredis statically (a dynamic import broke inside the Next.js bundle)', () => {
  const src = readFileSync(resolve(__dirname, '../redis-health.ts'), 'utf8')
  assert.ok(/^import \{ Redis \} from 'ioredis'/m.test(src), 'static import required')
  assert.ok(!/import\(\s*'ioredis'\s*\)/.test(src), "no `await import('ioredis')`: its named export is undefined in the server bundle")
})

test('API health: PINGs Redis and reports email-queue worker attachment and the deployed commit', () => {
  const src = readFileSync(resolve(__dirname, '../../../app/api/health/route.ts'), 'utf8')
  assert.ok(src.includes('pingAppRedis()'))
  assert.ok(src.includes('getWorkersCount()'))
  assert.ok(src.includes('RAILWAY_GIT_COMMIT_SHA'))
  assert.ok(/const ok = db === 'connected' && redis\.ok/.test(src), 'Redis must be part of API readiness')
  // 2026-09-15: a required queue with no consumer is not ready.
  assert.ok(/const ok = [^\n]*&& emailDelivery\.ready/.test(src), 'email-delivery worker attachment must be part of API readiness')
  assert.ok(/const counts = redis\.ok \? await queueWorkers\(\)/.test(src), 'worker counts are not asked while Redis is down')
  assert.ok(/singleFlightCache\(loadQueueWorkers, WORKER_COUNT_TTL_MS/.test(src), 'worker counts are cached and single-flight')
  // An UNKNOWN window is retried in a second: "unknown" still fails readiness,
  // but a single slow CLIENT LIST must not hold 503 for the full interval.
  assert.ok(/WORKER_COUNT_UNKNOWN_TTL_MS/.test(src) && /every\(\(c\) => c === null\)/.test(src), 'an unknown worker-count window gets a short retry TTL')
  for (const q of ['emailQueue', 'scheduledQueue', 'webhookRetryQueue', 'discordQueue']) assert.ok(src.includes(`count(${q})`), `${q} must be counted`)
})

// ── The test-environment guard itself ───────────────────────────────────

test('production database and Redis hosts are recognised', () => {
  assert.equal(looksLikeProductionUrl('postgresql://u:p@ep-example-123-pooler.us-east-1.aws.neon.tech/neondb'), true)
  assert.equal(looksLikeProductionUrl('redis://default:x@example-proxy.proxy.rlwy.net:12345'), true)
  assert.equal(looksLikeProductionUrl('postgresql://ci:ci@127.0.0.1:5432/ci'), false)
  assert.equal(looksLikeProductionUrl('redis://127.0.0.1:6379'), false)
  assert.equal(looksLikeProductionUrl(undefined), false)
})

test('a real Resend key is recognised; placeholders are not', () => {
  assert.equal(looksLikeRealResendKey('re_AbCdEf123456789_xyz'), true)
  assert.equal(looksLikeRealResendKey('re_placeholder'), false)
  assert.equal(looksLikeRealResendKey('re_test_whatever'), false)
  assert.equal(looksLikeRealResendKey(undefined), false)
})

test('assertNoProductionCredentials throws for a production URL or real key', () => {
  assert.throws(() => assertNoProductionCredentials({ DATABASE_URL: 'postgresql://x@ep-a-b-1.neon.tech/db' } as unknown as NodeJS.ProcessEnv), /UNSAFE TEST ENVIRONMENT/)
  assert.throws(() => assertNoProductionCredentials({ REDIS_TEST_URL: 'redis://x@a.proxy.rlwy.net:1' } as unknown as NodeJS.ProcessEnv), /UNSAFE/)
  assert.throws(() => assertNoProductionCredentials({ RESEND_API_KEY: 're_realLookingKey1234' } as unknown as NodeJS.ProcessEnv), /UNSAFE/)
  assert.doesNotThrow(() => assertNoProductionCredentials({ DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:5432/ci' } as unknown as NodeJS.ProcessEnv))
})

test('tests may only address example.com / test.invalid recipients', () => {
  assert.doesNotThrow(() => assertTestRecipient('someone@example.com'))
  assert.doesNotThrow(() => assertTestRecipient('x@test.invalid'))
  assert.throws(() => assertTestRecipient('real.customer@gmail.com'), /non-test recipient/)
  assert.throws(() => assertTestRecipient('hello@moveitclearit.com'), /non-test recipient/)
})

test('the pre-existing DB-gated suites refuse a production DATABASE_URL', () => {
  for (const rel of ['schema-drift.test.ts', 'lead-concurrency.test.ts', 'email-bounce-cohort.test.ts', 'lead-notification-outbox.test.ts', 'discord-http-retry.test.ts', 'true-e2e-browser-to-postgres.test.ts']) {
    const src = readFileSync(resolve(__dirname, rel), 'utf8')
    assert.ok(src.includes('assertNoProductionCredentials'), `${rel} must call the shared production-credential guard`)
  }
})
