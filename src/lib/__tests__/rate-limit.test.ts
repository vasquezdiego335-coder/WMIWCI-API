import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkBucket, rateLimit, LIMITS, type Bucket } from '../rate-limit'

// ════════════════════════════════════════════════════════════════════════
//  Offline tests. The pure fixed-window bucket is fully deterministic. The
//  rateLimit() degraded-path tests assume Upstash env is NOT set (true in the
//  test tree — no .env), so the local fallback + failMode policy is exercised.
//  Unique identifiers per test avoid cross-test bucket bleed (module-level store).
// ════════════════════════════════════════════════════════════════════════

test('checkBucket: allows up to the limit, then blocks', () => {
  const store = new Map<string, Bucket>()
  const now = 1000
  assert.equal(checkBucket(store, 'k', 3, 1000, now), true) // 1
  assert.equal(checkBucket(store, 'k', 3, 1000, now), true) // 2
  assert.equal(checkBucket(store, 'k', 3, 1000, now), true) // 3
  assert.equal(checkBucket(store, 'k', 3, 1000, now), false) // 4 → blocked
})

test('checkBucket: window reset allows again', () => {
  const store = new Map<string, Bucket>()
  assert.equal(checkBucket(store, 'k', 1, 1000, 1000), true)
  assert.equal(checkBucket(store, 'k', 1, 1000, 1500), false) // same window
  assert.equal(checkBucket(store, 'k', 1, 1000, 2001), true) // window elapsed
})

test('checkBucket: different keys are independent', () => {
  const store = new Map<string, Bucket>()
  assert.equal(checkBucket(store, 'a', 1, 1000, 0), true)
  assert.equal(checkBucket(store, 'b', 1, 1000, 0), true) // b not affected by a
  assert.equal(checkBucket(store, 'a', 1, 1000, 0), false)
})

test('rateLimit fail-closed (login): local fallback blocks past the limit', async () => {
  const cfg = { ...LIMITS.login, limit: 3 }
  const ip = 'ip-closed-1'
  let last
  for (let i = 0; i < 3; i++) last = await rateLimit(cfg, [ip])
  assert.equal(last!.ok, true)
  const over = await rateLimit(cfg, [ip])
  assert.equal(over.ok, false) // fail-closed enforces locally
  assert.equal(over.degraded, true)
  assert.ok(over.retryAfterSec > 0)
})

test('rateLimit fail-open (contact): never hard-blocks when degraded', async () => {
  const cfg = { ...LIMITS.contact, limit: 2 }
  const ip = 'ip-open-1'
  for (let i = 0; i < 5; i++) {
    const r = await rateLimit(cfg, [ip])
    assert.equal(r.ok, true) // fail-open always allows on the degraded path
    assert.equal(r.degraded, true)
  }
})

test('rateLimit: different IPs get independent buckets', async () => {
  const cfg = { ...LIMITS.login, limit: 1 }
  const a = await rateLimit(cfg, ['ip-A'])
  const b = await rateLimit(cfg, ['ip-B'])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true) // B not blocked by A
  const a2 = await rateLimit(cfg, ['ip-A'])
  assert.equal(a2.ok, false) // A's own bucket is exhausted
})

test('rateLimit: different buckets (routes) are independent for the same IP', async () => {
  const ip = 'ip-shared'
  const login = await rateLimit({ ...LIMITS.login, limit: 1 }, [ip])
  const booking = await rateLimit({ ...LIMITS.booking, limit: 1 }, [ip])
  assert.equal(login.ok, true)
  assert.equal(booking.ok, true) // booking bucket independent of login bucket
})
