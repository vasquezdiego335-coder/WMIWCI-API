import { Redis, RedisOptions } from 'ioredis'
import type { ConnectionOptions } from 'bullmq'

// ════════════════════════════════════════════════════════════════════════
//  Redis connection management
//  ────────────────────────────────────────────────────────────────────
//  TWO exports, for two different consumers:
//
//  1. `redis`          — a shared ioredis instance for direct commands
//                        (admin queue stats, ad-hoc queries). Singleton.
//
//  2. `bullConnection` — a plain config object (NOT an instance) that
//                        BullMQ uses to create its OWN internal connections.
//                        This prevents the "Connection is closed" spam that
//                        occurs when BullMQ duplicates a shared instance and
//                        the duplicates' error events go unhandled.
//
//  Both read REDIS_URL from process.env at call time, which is safe as
//  long as `import 'dotenv/config'` runs before any import that touches
//  this module (see the ⚠️ comment in src/workers/index.ts).
// ════════════════════════════════════════════════════════════════════════

// ── Common options shared by both the singleton and BullMQ connections ──
function buildRedisOptions(): RedisOptions {
  return {
    maxRetriesPerRequest: null,   // required by BullMQ
    enableReadyCheck: false,
    // ── Upstash Free Tier drops idle TCP connections aggressively.
    //    These settings let ioredis reconnect quietly:
    retryStrategy(times) {
      return Math.min(times * 50, 2000)  // 50ms, 100ms, … cap 2s
    },
    reconnectOnError(err) {
      const msg = err.message ?? ''
      return msg.includes('ECONNRESET') || msg.includes('READONLY')
    },
  }
}

/**
 * In PRODUCTION, a missing REDIS_URL is a configuration failure, not a default.
 *
 * Falling back to localhost on a Railway service produces a Redis that is
 * always down and never noticed: every enqueue fails, the durable notification
 * outbox stops being drained, and the only symptom is a warning in a log
 * nobody reads. Failing fast turns a silent, permanent outage into a loud one
 * at boot, which is the only point at which anybody is looking.
 *
 * Outside production the localhost default stays, because a developer running
 * the app locally genuinely does want it.
 */
function requireRedisUrl(caller: string): string {
  const raw = process.env.REDIS_URL
  if (raw) return raw
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `REDIS_URL is not set (${caller}). Refusing to fall back to localhost in production: ` +
        'the queue would appear healthy while every job silently failed. ' +
        'Set REDIS_URL on this service.',
    )
  }
  return 'redis://localhost:6379'
}

// ── 1. Shared singleton for direct ioredis calls ─────────────────────────
let redisClient: Redis | undefined

export function getRedis(): Redis {
  if (!redisClient) {
    const url = requireRedisUrl('getRedis')
    if (!process.env.REDIS_URL) {
      console.warn('[Redis] ⚠️  REDIS_URL is NOT set — direct client falling back to localhost (non-production only).')
    }

    // Match the Railway dual-stack DNS fix used for the BullMQ config so both
    // connection paths behave identically against the rlwy.net proxy.
    const extra: RedisOptions = {}
    if (url.includes('rlwy.net') || url.includes('railway.internal')) {
      extra.family = 0
    }

    redisClient = new Redis(url, {
      ...buildRedisOptions(),
      ...extra,
      lazyConnect: true,
    })

    let wasConnected = false
    redisClient.on('error', (err) => {
      const msg = err.message ?? ''
      if (msg.includes('Connection is closed') || msg.includes('ECONNRESET')) {
        if (wasConnected) {
          console.warn('[Redis] Connection dropped (Upstash idle timeout) — reconnecting…')
          wasConnected = false
        }
        return
      }
      console.error('[Redis] Error:', msg)
    })
    redisClient.on('connect', () => {
      if (!wasConnected) {
        const safeUrl = url.replace(/:([^@]+)@/, ':****@')
        console.log(`[Redis] Connected → ${safeUrl}`)
        wasConnected = true
      }
    })
  }
  return redisClient
}

// Lazy getter — no connection created at import time.
// Workers and direct callers should use `getRedis()` or this proxy.
export const redis = new Proxy({} as Redis, {
  get(_target, prop, receiver) {
    return Reflect.get(getRedis(), prop, receiver)
  },
})

// ── 2. BullMQ connection config (NOT a shared instance) ──────────────────
//
// BullMQ internally creates 2-3 Redis connections per Queue/Worker (one for
// commands, one for pub/sub, one for blocking). If you hand it an ioredis
// *instance*, it calls `.duplicate()` — and the duplicates don't inherit
// your error handler, so their "Connection is closed" errors print as raw
// uncaught exceptions.
//
// Instead we give BullMQ the parsed config. It creates managed connections
// internally and handles reconnect/error lifecycle itself.
export function getBullConnection(): ConnectionOptions {
  const rawUrl = process.env.REDIS_URL
  const url = requireRedisUrl('getBullConnection')

  // ── DIAGNOSTIC ──────────────────────────────────────────────────────
  const safeUrl = url.replace(/:([^@/]+)@/, ':****@')
  if (!rawUrl) {
    console.warn('[Redis] ⚠️  REDIS_URL is NOT set — falling back to localhost (non-production only). ' +
      'Set REDIS_URL on this service or the app cannot reach Redis.')
  }
  console.log(`[Redis] getBullConnection: URL="${safeUrl}"`)

  // Parse the URL into the explicit host/port/password/tls shape BullMQ needs.
  // We ALWAYS return a config carrying host+port, even on parse failure —
  // handing BullMQ a config without a host is what produces the cryptic
  // "Cannot read properties of undefined (reading 'auth')" crash.
  let parsed: URL | undefined
  try {
    parsed = new URL(url)
  } catch (err) {
    console.error(`[Redis] ❌ URL parse FAILED for "${safeUrl}": ` +
      `${err instanceof Error ? err.message : String(err)}. Using localhost:6379 fallback.`)
  }

  const host = parsed?.hostname || 'localhost'
  const port = parseInt(parsed?.port || '6379', 10)

  const opts: Record<string, unknown> = {
    ...buildRedisOptions(),
    host,
    port,
    lazyConnect: false,
  }

  if (parsed?.password) opts.password = decodeURIComponent(parsed.password)
  // ioredis defaults the username to "default"; only set it when it's custom.
  if (parsed?.username && parsed.username !== 'default') {
    opts.username = decodeURIComponent(parsed.username)
  }

  // TLS: rediss:// scheme, or providers that require it (Upstash).
  if (parsed?.protocol === 'rediss:' || url.includes('upstash.io')) {
    opts.tls = {}
  }

  // Railway's Redis proxy (rlwy.net) and internal hostnames (*.railway.internal)
  // resolve on a dual IPv4/IPv6 stack. family:0 lets Node try both records
  // instead of failing with ETIMEDOUT when only one address family is reachable.
  if (host.includes('rlwy.net') || host.includes('railway.internal')) {
    opts.family = 0
  }

  console.log(`[Redis] BullMQ config → host=${host} port=${port} ` +
    `tls=${opts.tls ? 'on' : 'off'} family=${opts.family ?? 'default'} ` +
    `auth=${opts.password ? 'yes' : 'no'}`)

  return opts as unknown as ConnectionOptions
}

// Lazy getter — config parsed on first access, not at import time.
// getBullConnection() only parses a URL (no network call), so the
// lazy wrapper is lightweight insurance against edge-case build failures.
let _bullConnection: ConnectionOptions | undefined
export function getLazyBullConnection(): ConnectionOptions {
  if (!_bullConnection) _bullConnection = getBullConnection()
  return _bullConnection
}

// Pre-built config — safe to call eagerly because getBullConnection()
// only parses the REDIS_URL string into host/port/password; it opens
// NO network connections.  Workers (persistent processes) import this
// directly; serverless routes go through the lazy Queue proxies in
// @/lib/queues which call getLazyBullConnection() on first use.
export const bullConnection: ConnectionOptions = getBullConnection()
