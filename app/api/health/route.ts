import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { checkEnv } from '@/lib/env'
import { unsafeUrlReason } from '@/emails/validation'
import { pingAppRedis } from '@/lib/redis-health'
import { evaluateEmailDelivery, singleFlightCache, type QueueWorkerCounts } from '@/lib/worker-health'

export const revalidate = 0

// ── APP_URL SELF-CHECK (production incident 2026-07-24) ────────────────────
// APP_URL sat in production as `https://PASTE_YOUR_LIVE_URL_HERE`, so every
// portal / checkout-resume / unsubscribe link in every email 404'd — and
// nothing surfaced it, because `checkEnv()` only ever reported that the var was
// PRESENT, never whether its value was usable. Presence is not configuration.
//
// APP_URL is public by definition (it is printed in customer emails), so
// reporting its host here discloses nothing secret while making a placeholder
// or wrong-host value instantly visible to an operator — and to any uptime
// check watching this endpoint.
function urlVarHealth(name: string) {
  const raw = process.env[name]?.trim() ?? ''
  if (!raw) return { configured: false, reason: 'unset' as string | null, host: null as string | null }
  const reason = unsafeUrlReason(raw) // catches placeholders, http://, localhost, …
  let host: string | null = null
  try {
    host = new URL(raw).host
  } catch {
    /* unparseable — reason above already says so */
  }
  return { configured: reason === null, reason, host }
}

const appUrlHealth = () => urlVarHealth('APP_URL')

/**
 * Every env var that becomes a LINK IN A CUSTOMER EMAIL.
 *
 * Reported because presence is not configuration: MARKETING_SITE_URL feeds
 * bookingUrl, redeemUrl and the referral fallback, so a stale value silently
 * mails dead links to customers (it was pointing at a retired domain when this
 * was added). Hosts are public by definition — they are printed in the emails.
 *
 * Advisory only: these do NOT fail the readiness probe, because a link var can
 * be legitimately unset (the code has live fallbacks). APP_URL stays a hard
 * requirement above since nothing can substitute for it.
 */
function linkVarsHealth() {
  return {
    MARKETING_SITE_URL: urlVarHealth('MARKETING_SITE_URL'),
    REFERRAL_URL: urlVarHealth('REFERRAL_URL'),
    GOOGLE_REVIEW_URL: urlVarHealth('GOOGLE_REVIEW_URL'),
  }
}

/**
 * Email feature flags AS THIS PROCESS SEES THEM.
 *
 * Reported because a flag set in the hosting dashboard and a flag visible to the
 * running process are different facts: the value only enters `process.env` on
 * restart, and an exact-string comparison ('true') rejects "TRUE", "True", "1"
 * and any stray whitespace. An operator set EMAIL_PROMOTIONS_ENABLED, saw the
 * admin still report it off, and had no way to tell which of those it was.
 *
 * `raw` is the literal value so a casing/whitespace mistake is visible, and
 * `effective` is what the code actually decides. These are booleans and short
 * words — never secrets.
 */
function emailFlags() {
  const flag = (name: string) => {
    const raw = process.env[name]
    return { raw: raw === undefined ? null : raw, effective: raw === 'true' }
  }
  return {
    EMAIL_SENDING_ENABLED: flag('EMAIL_SENDING_ENABLED'),
    EMAIL_PROMOTIONS_ENABLED: flag('EMAIL_PROMOTIONS_ENABLED'),
    EMAIL_JOURNEYS_ENABLED: flag('EMAIL_JOURNEYS_ENABLED'),
    MARKETING_FOLLOWUPS_ENABLED: flag('MARKETING_FOLLOWUPS_ENABLED'),
    REFERRAL_PROGRAM_ENABLED: flag('REFERRAL_PROGRAM_ENABLED'),
    PARTIAL_BOOKING_EMAIL_CAPTURE_ENABLED: flag('PARTIAL_BOOKING_EMAIL_CAPTURE_ENABLED'),
    OUTBOX_ENABLED: flag('OUTBOX_ENABLED'),
    OUTBOX_EMAIL_DRYRUN: flag('OUTBOX_EMAIL_DRYRUN'),
    // THIS process's copy. Discovery runs on the WORKER, whose /health reports
    // its own copy — compare the two when they disagree.
    EMAIL_MARKETING_AGENT_ENABLED: flag('EMAIL_MARKETING_AGENT_ENABLED'),
  }
}

const UNKNOWN_COUNTS: QueueWorkerCounts = { email: null, scheduled: null, 'webhook-retry': null, discord: null }
const WORKER_COUNT_TIMEOUT_MS = 2_000

/**
 * How many BullMQ workers are attached to each email-delivery queue RIGHT NOW,
 * as seen from this (API) process — i.e. whether anything will pick up the
 * quote confirmation, outbox drain or paid-deposit event this API enqueues.
 *
 * Bounded: the shared queue connection retries forever during a Redis outage,
 * so the whole question is raced against ONE timeout (a timed-out queue reads
 * null = unknown). Cached for 10s and single-flight: each getWorkersCount() is a
 * CLIENT LIST on Redis's main thread, and this endpoint is public and polled.
 */
async function loadQueueWorkers(): Promise<QueueWorkerCounts> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const { emailQueue, scheduledQueue, webhookRetryQueue, discordQueue } = await import('@/lib/queues')
    const count = async (q: { getWorkersCount(): Promise<number> }) => {
      try {
        return await q.getWorkersCount()
      } catch {
        return null
      }
    }
    const all = Promise.all([count(emailQueue), count(scheduledQueue), count(webhookRetryQueue), count(discordQueue)])
    const result = await Promise.race([
      all,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), WORKER_COUNT_TIMEOUT_MS)
      }),
    ])
    if (!result) return { ...UNKNOWN_COUNTS }
    const [email, scheduled, webhookRetry, discord] = result
    return { email, scheduled, 'webhook-retry': webhookRetry, discord }
  } catch {
    return { ...UNKNOWN_COUNTS }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
const queueWorkers = singleFlightCache(loadQueueWorkers, 10_000)

// GET /api/health — readiness probe (GET /api/health/live is pure liveness).
// Returns 200 when the DB is reachable AND Redis answers a PING AND all required
// env vars are present AND APP_URL is a usable URL AND every email-delivery
// queue (email, scheduled, webhook-retry) has a worker attached; 503 otherwise.
// Only env-var PRESENCE is reported, never secret values (APP_URL's host is
// public by design).
export async function GET(): Promise<NextResponse> {
  const env = checkEnv()
  const appUrl = appUrlHealth()
  const timestamp = new Date().toISOString()

  let db: 'connected' | 'unreachable' = 'unreachable'
  try {
    await prisma.$queryRaw`SELECT 1`
    db = 'connected'
  } catch {
    db = 'unreachable'
  }

  // A REAL PING. Every quote confirmation and booking email starts as a queue
  // job this process adds; without Redis they are captured but never sent.
  const redis = await pingAppRedis()
  // Not asked while Redis is down: every count would hang into the offline queue.
  const counts = redis.ok ? await queueWorkers() : { ...UNKNOWN_COUNTS }
  const emailDelivery = evaluateEmailDelivery(counts)

  // A placeholder/unusable APP_URL is a DEGRADED system: the app runs, but every
  // link it mails is broken. That must fail the readiness probe, not hide.
  // EMAIL DELIVERY IS PART OF READINESS (2026-09-15). It used to be reported
  // beside a green status: zero workers on the email queue still said "ok",
  // while every quote confirmation this API enqueued waited for nobody.
  const ok = db === 'connected' && redis.ok && env.ok && appUrl.configured && emailDelivery.ready
  return NextResponse.json(
    {
      status: ok ? 'ok' : 'degraded',
      db,
      redis,
      emailDelivery,
      // Kept for existing runbooks (docs/email-operations.md).
      emailQueue: { workersAttached: counts.email },
      commit: (process.env.RAILWAY_GIT_COMMIT_SHA ?? '').slice(0, 12) || null,
      appUrl,
      linkVars: linkVarsHealth(),
      emailFlags: emailFlags(),
      env: {
        ok: env.ok,
        missingRequired: env.missingRequired,
        groups: env.groups,
      },
      timestamp,
    },
    { status: ok ? 200 : 503 }
  )
}
