// ════════════════════════════════════════════════════════════════════════
//  rate-limit.ts — distributed rate limiting for public + auth endpoints.
//
//  WHY THIS EXISTS: the old limiter lived in Next middleware as an in-memory
//  Map AND its configured paths (/api/auth/login, /api/bookings) were never in
//  the middleware `matcher`, so they never ran. On Railway/serverless an
//  in-memory counter is also per-instance, so it resets constantly. This module
//  uses the already-installed @upstash/ratelimit (REST — cross-instance) and is
//  called INSIDE each sensitive route handler, so protection can't be bypassed
//  by a matcher gap.
//
//  KEYS: hashed (sha256) so raw IPs / emails never land in Redis. Callers pass
//  IP as the primary identifier; login is keyed by IP only on purpose — keying
//  by email would let an attacker lock a victim's account by rotating attempts.
//
//  DEGRADED BEHAVIOUR (Upstash unset or unreachable) is governed by failMode:
//    • 'open'   → low-risk forms (contact/lead): allow, with a per-instance
//                 in-memory soft cap as a courtesy backstop. Never hard-block a
//                 legitimate inquiry because the limiter backend blipped.
//    • 'closed' → high-risk (login, booking→Stripe): fall back to the local
//                 in-memory limiter so a single instance is still constrained
//                 (a normal user is well under the limit; a flood is slowed).
//
//  Pure `checkBucket` + the degraded path are unit-tested offline; the Upstash
//  path activates only when the REST env vars are present.
// ════════════════════════════════════════════════════════════════════════
import { createHash } from 'crypto'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { NextResponse } from 'next/server'
import { apiLogger } from './logger'

export type FailMode = 'open' | 'closed'

export type RateLimitConfig = {
  /** Bucket name — the action/route, e.g. 'login', 'booking', 'contact'. */
  name: string
  limit: number
  windowSec: number
  failMode: FailMode
}

export type RateResult = {
  ok: boolean
  limit: number
  remaining: number
  retryAfterSec: number
  /** True when the distributed limiter was unavailable and we used the fallback. */
  degraded: boolean
}

// ── Named policies (single source of truth for the numbers) ───────────────────
export const LIMITS = {
  // High-risk: keyed by IP only (no email-lockout DoS). 10 tries / 15 min.
  login: { name: 'login', limit: 10, windowSec: 15 * 60, failMode: 'closed' } as RateLimitConfig,
  // Booking creates a Stripe Checkout session — cap abuse but stay well above a
  // real customer's 1–2 attempts. 5 / hour.
  booking: { name: 'booking', limit: 5, windowSec: 60 * 60, failMode: 'closed' } as RateLimitConfig,
  // Low-risk public inquiry forms — fail open so a limiter blip never eats a lead.
  contact: { name: 'contact', limit: 5, windowSec: 10 * 60, failMode: 'open' } as RateLimitConfig,
  lead: { name: 'lead', limit: 8, windowSec: 10 * 60, failMode: 'open' } as RateLimitConfig,
  coupon: { name: 'coupon', limit: 6, windowSec: 10 * 60, failMode: 'open' } as RateLimitConfig,
  // Server-to-server (already token-gated) — a generous ceiling against runaway loops.
  notifyLead: { name: 'notify-lead', limit: 60, windowSec: 60, failMode: 'open' } as RateLimitConfig,
} as const

// ── Pure in-memory bucket (fixed window). Exported for offline tests. ─────────
export type Bucket = { count: number; resetAt: number }
export function checkBucket(
  store: Map<string, Bucket>,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): boolean {
  const e = store.get(key)
  if (!e || e.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (e.count >= limit) return false
  e.count++
  return true
}

const localStore = new Map<string, Bucket>()

// ── Upstash REST limiter (cross-instance). Only built when env is present. ────
let _redis: Redis | null | undefined
function getRedis(): Redis | null {
  if (_redis !== undefined) return _redis
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  _redis = url && token ? new Redis({ url, token }) : null
  return _redis
}

const _limiters = new Map<string, Ratelimit>()
function getLimiter(cfg: RateLimitConfig): Ratelimit | null {
  const redis = getRedis()
  if (!redis) return null
  const cacheKey = `${cfg.name}:${cfg.limit}:${cfg.windowSec}`
  let l = _limiters.get(cacheKey)
  if (!l) {
    l = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(cfg.limit, `${cfg.windowSec} s`),
      prefix: `rl:${cfg.name}`,
      analytics: false,
    })
    _limiters.set(cacheKey, l)
  }
  return l
}

/** Hash the joined identifiers so raw IPs/emails/phones never reach Redis. */
function hashId(identifiers: Array<string | null | undefined>): string {
  const joined = identifiers.map((x) => (x ?? '').trim().toLowerCase()).filter(Boolean).join('|') || 'anon'
  return createHash('sha256').update(joined).digest('hex').slice(0, 24)
}

/**
 * Check a rate limit. Never throws. Uses the distributed limiter when Upstash is
 * configured + reachable; otherwise applies the degraded policy for failMode.
 */
export async function rateLimit(cfg: RateLimitConfig, identifiers: Array<string | null | undefined>): Promise<RateResult> {
  const id = hashId(identifiers)
  const key = `${cfg.name}:${id}`

  const limiter = getLimiter(cfg)
  if (limiter) {
    try {
      const r = await limiter.limit(key)
      return {
        ok: r.success,
        limit: r.limit,
        remaining: r.remaining,
        retryAfterSec: Math.max(0, Math.ceil((r.reset - Date.now()) / 1000)),
        degraded: false,
      }
    } catch (err) {
      apiLogger.warn({ err: err instanceof Error ? err.message : String(err), bucket: cfg.name }, 'rate limiter backend error — using degraded policy')
      // fall through to degraded handling
    }
  }

  // Degraded: no Upstash configured, or the REST call failed.
  const allowedLocal = checkBucket(localStore, key, cfg.limit, cfg.windowSec * 1000, Date.now())
  if (cfg.failMode === 'open') {
    // Low-risk: never hard-block when the backend is down. The local soft cap
    // only records; we still allow, but surface `degraded` so callers can log.
    return { ok: true, limit: cfg.limit, remaining: allowedLocal ? cfg.limit - 1 : 0, retryAfterSec: 0, degraded: true }
  }
  // High-risk: honor the local per-instance decision.
  return {
    ok: allowedLocal,
    limit: cfg.limit,
    remaining: allowedLocal ? cfg.limit - 1 : 0,
    retryAfterSec: allowedLocal ? 0 : cfg.windowSec,
    degraded: true,
  }
}

/** Standard 429 response with Retry-After. Body is deliberately generic so it
 *  never reveals whether an account/email exists. */
export function tooManyRequests(result: RateResult): NextResponse {
  return NextResponse.json(
    { error: 'Too many requests. Please slow down and try again shortly.' },
    { status: 429, headers: { 'Retry-After': String(result.retryAfterSec || 60) } },
  )
}

/** Extract the client IP from a request's forwarded headers. */
export function clientIp(req: { headers: { get(name: string): string | null } }): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip')?.trim() || 'unknown'
}
