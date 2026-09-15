// ════════════════════════════════════════════════════════════════════════
//  DISPOSABLE TEST ENVIRONMENT GUARD — shared by every DB/Redis-gated suite
//  ---------------------------------------------------------------------
//  Suites used to decide "run against a database" from `DATABASE_URL` being
//  SET, never from where it points. A developer shell (or a `.env` loaded by
//  `dotenv/config` in an imported worker module) holding the PRODUCTION Neon
//  URL would have run schema-mutating fixtures against live data, and a real
//  Resend key could have mailed a real customer.
//
//  These helpers answer two questions, in this order:
//    1. Is a disposable service configured at all?  → otherwise SKIP
//    2. Is it provably NOT production?              → otherwise THROW
//  A production-looking target is a hard failure, never a skip: silently
//  skipping would hide exactly the misconfiguration this exists to catch.
// ════════════════════════════════════════════════════════════════════════

/** Hostnames that are production infrastructure for this business. */
const PRODUCTION_HOST_PATTERNS = [/neon\.tech/i, /rlwy\.net/i, /railway\.internal/i, /railway\.app/i, /upstash\.io/i]

/** True when a URL/connection string points at production-looking infrastructure. */
export function looksLikeProductionUrl(url: string | undefined): boolean {
  if (!url) return false
  return PRODUCTION_HOST_PATTERNS.some((re) => re.test(url))
}

/** A real Resend key starts with `re_`; tests must never hold one. */
export function looksLikeRealResendKey(key: string | undefined): boolean {
  if (!key) return false
  const k = key.trim()
  return /^re_[A-Za-z0-9_]{8,}$/.test(k) && !/^re_test_|^re_(dummy|fake|placeholder)/i.test(k)
}

/** Recipient domains a test is allowed to address. Everything else is refused. */
const TEST_RECIPIENT = /@(example\.(com|org|net)|test\.invalid|moveitclearit\.test)$/i

export function assertTestRecipient(email: string): void {
  if (!TEST_RECIPIENT.test(email.trim())) {
    throw new Error(`refusing to use a non-test recipient in a test: tests may only address @example.com / @test.invalid (got a ${email.split('@')[1] ?? 'malformed'} address)`)
  }
}

/** Throws when ANY credential in the environment looks like production. */
export function assertNoProductionCredentials(env: NodeJS.ProcessEnv = process.env): void {
  const problems: string[] = []
  if (looksLikeProductionUrl(env.DATABASE_URL)) problems.push('DATABASE_URL points at production-looking infrastructure (neon.tech / railway)')
  if (looksLikeProductionUrl(env.REDIS_URL)) problems.push('REDIS_URL points at production-looking infrastructure (rlwy.net / railway)')
  if (looksLikeProductionUrl(env.REDIS_TEST_URL)) problems.push('REDIS_TEST_URL points at production-looking infrastructure')
  if (looksLikeRealResendKey(env.RESEND_API_KEY)) problems.push('RESEND_API_KEY looks like a real Resend key')
  if (problems.length) {
    throw new Error(`UNSAFE TEST ENVIRONMENT — refusing to run:\n  - ${problems.join('\n  - ')}\nUnset these (or point them at disposable local services) and re-run.`)
  }
}

/**
 * For `test(name, { skip: dbSkip() }, …)`: a skip reason when no disposable
 * Postgres is configured, `false` when one is. THROWS for a production URL.
 */
export function dbSkip(): string | false {
  assertNoProductionCredentials()
  return process.env.DATABASE_URL ? false : 'no disposable DATABASE_URL (CI provides a Postgres service container)'
}

/** Same contract for Redis-backed suites, keyed on REDIS_TEST_URL. */
export function redisSkip(): string | false {
  assertNoProductionCredentials()
  return process.env.REDIS_TEST_URL ? false : 'no disposable REDIS_TEST_URL (CI provides a Redis service container)'
}
