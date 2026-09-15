// ════════════════════════════════════════════════════════════════════════
//  REDIS HEALTH — an actual PING, not the presence of REDIS_URL
//  ---------------------------------------------------------------------
//  The worker's /health used to report `redis: true` the moment REDIS_URL
//  existed, before any connection was attempted. A wrong password, a deleted
//  Redis service or a proxy outage all read as healthy. This helper answers the
//  only question that matters — does Redis reply right now? — with a bounded
//  timeout, and never includes the URL or any credential in its output.
// ════════════════════════════════════════════════════════════════════════

export type RedisPingResult = {
  ok: boolean
  latencyMs: number | null
  /** Short, credential-free reason when not ok. */
  error: string | null
}

export type Pingable = { ping(): Promise<string> }

export const REDIS_PING_TIMEOUT_MS = 2_000

/** Strip anything URL- or credential-shaped from an error message. */
export function sanitizeRedisError(message: string): string {
  return message
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, '<url>')
    .replace(/(password|auth|token)[=:]\s*\S+/gi, '$1=<redacted>')
    .slice(0, 160)
}

/**
 * PING with a timeout. Pure with respect to the client: tests pass a fake, the
 * health endpoints pass the shared ioredis singleton.
 */
export async function pingRedis(client: Pingable, timeoutMs: number = REDIS_PING_TIMEOUT_MS): Promise<RedisPingResult> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const reply = await Promise.race([
      client.ping(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no PONG within ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
    if (String(reply).toUpperCase() !== 'PONG') {
      return { ok: false, latencyMs: Date.now() - started, error: 'unexpected PING reply' }
    }
    return { ok: true, latencyMs: Date.now() - started, error: null }
  } catch (err) {
    return { ok: false, latencyMs: null, error: sanitizeRedisError(err instanceof Error ? err.message : String(err)) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ── The probe client ────────────────────────────────────────────────────
// NOT the shared application client: that one runs with
// maxRetriesPerRequest:null (a BullMQ requirement), so during an outage a PING
// would sit in its offline queue forever and every health poll would add one
// more. The probe fails fast instead — no offline queue, one retry, short
// connect timeout — and is created once and reused.
type ProbeClient = Pingable & { status: string; connect(): Promise<void> }
let probe: ProbeClient | null = null

async function probeClient(url: string): Promise<ProbeClient> {
  if (probe) return probe
  const { Redis } = await import('ioredis')
  const host = (() => {
    try {
      return new URL(url).hostname
    } catch {
      return ''
    }
  })()
  const client = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: REDIS_PING_TIMEOUT_MS,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
    ...(host.includes('rlwy.net') || host.includes('railway.internal') ? { family: 0 } : {}),
  })
  // A probe must never crash the process or spam the log on a flapping link.
  client.on('error', () => undefined)
  probe = client as unknown as ProbeClient
  return probe
}

let cached: { at: number; result: RedisPingResult } | null = null
const CACHE_MS = 5_000

/** PING the application's Redis (REDIS_URL) through the fail-fast probe. Cached 5s. */
export async function pingAppRedis(timeoutMs: number = REDIS_PING_TIMEOUT_MS): Promise<RedisPingResult> {
  const url = process.env.REDIS_URL
  if (!url) return { ok: false, latencyMs: null, error: 'REDIS_URL is not set' }
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.result
  let result: RedisPingResult
  try {
    const client = await probeClient(url)
    if (client.status === 'wait' || client.status === 'end') {
      await Promise.race([
        client.connect(),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('connect timed out')), timeoutMs)),
      ]).catch(() => undefined)
    }
    result = await pingRedis(client, timeoutMs)
  } catch (err) {
    result = { ok: false, latencyMs: null, error: sanitizeRedisError(err instanceof Error ? err.message : String(err)) }
  }
  cached = { at: Date.now(), result }
  return result
}
