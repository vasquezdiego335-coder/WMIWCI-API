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

// ── 1. Shared singleton for direct ioredis calls ─────────────────────────
let redisClient: Redis | undefined

export function getRedis(): Redis {
  if (!redisClient) {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379'
    redisClient = new Redis(url, {
      ...buildRedisOptions(),
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

export const redis: Redis = getRedis()

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
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379'

  // Parse the URL into host/port/password/username/tls that BullMQ expects.
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // If the URL is not parseable (bare host:port), fall through to the
    // raw-URL approach. ioredis handles non-standard formats internally.
    return {
      ...buildRedisOptions(),
      lazyConnect: false,
    } as unknown as ConnectionOptions
  }

  const opts: Record<string, unknown> = {
    ...buildRedisOptions(),
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    lazyConnect: false,
  }

  if (parsed.password) opts.password = decodeURIComponent(parsed.password)
  if (parsed.username && parsed.username !== 'default') {
    opts.username = decodeURIComponent(parsed.username)
  }

  // Upstash requires TLS on port 6379 (rediss://) or explicitly.
  if (parsed.protocol === 'rediss:' || url.includes('upstash.io')) {
    opts.tls = {}
  }

  return opts as unknown as ConnectionOptions
}

// Pre-built config — import this in queues and workers.
export const bullConnection: ConnectionOptions = getBullConnection()
