// ════════════════════════════════════════════════════════════════════════
//  WORKER HEALTH VERDICT — pure, so the rules are unit-tested offline
//  ---------------------------------------------------------------------
//  The worker's /health used to say "ok" when REDIS_URL merely existed and the
//  worker count was non-zero — both facts true the instant the process started,
//  whether or not Redis answered or a single worker was actually consuming.
//  Health is real observations:
//    1. no required configuration is missing or invalid;
//    2. Redis answers a PING (src/lib/redis-health.ts);
//    3. every BullMQ worker is running, not paused, and has CONNECTED (its
//       'ready' event fired — bullmq sets isRunning() before any connection);
//    4. Postgres answers SELECT 1 (readiness only, cached by the host);
//    5. every recurring schedule is registered (src/lib/cron-schedules.ts),
//       counted only after the first reconcile pass or a boot grace period.
//  The optional inputs (4, 5, attachment, phase) are judged only when supplied,
//  so older callers keep their exact verdicts.
//  The Discord gateway is REPORTED but does not decide health: approval cards
//  post over REST, so a reconnecting gateway does not stop customer email.
// ════════════════════════════════════════════════════════════════════════

export type WorkerAttachment = {
  name: string
  running: boolean
  paused: boolean
  /** false = constructed but its Redis connection never became ready. Omitted = not judged. */
  attached?: boolean
}

/** Structural subset of CronStatus (src/lib/cron-schedules.ts). */
export type ScheduleHealth = { firstPassDone: boolean; missing: string[] }

export type WorkerHealthInput = {
  envMissing: string[]
  /** null = not checked (workers never started). */
  redis: { ok: boolean } | null
  workers: WorkerAttachment[]
  /** Workers the host is expected to run; fewer than this is degraded. */
  expectedWorkers: number
  /** Names + reasons (never values) for present-but-unusable configuration. */
  configInvalid?: string[]
  /** Host startup phase; anything but 'running' is not ready. */
  phase?: string
  /** undefined = not judged; null = not checked yet. */
  db?: { ok: boolean } | null
  /** undefined = not judged; null = the scheduled worker has not started. */
  schedules?: { status: ScheduleHealth | null; bootGraceElapsed: boolean } | null
}

export type WorkerHealthVerdict = { ok: boolean; problems: string[] }

export function evaluateWorkerHealth(input: WorkerHealthInput): WorkerHealthVerdict {
  const problems: string[] = []
  if (input.phase !== undefined && input.phase !== 'running') problems.push(`worker host is not running (phase: ${input.phase})`)
  if (input.envMissing.length > 0) problems.push(`missing configuration: ${input.envMissing.join(', ')}`)
  if (input.configInvalid && input.configInvalid.length > 0) problems.push(`invalid configuration: ${input.configInvalid.join('; ')}`)
  if (!input.redis) problems.push('redis not checked (workers not started)')
  else if (!input.redis.ok) problems.push('redis did not answer PING')
  if (input.db !== undefined) {
    if (!input.db) problems.push('database not checked (workers not started)')
    else if (!input.db.ok) problems.push('database did not answer SELECT 1')
  }
  if (input.workers.length < input.expectedWorkers) {
    problems.push(`only ${input.workers.length} of ${input.expectedWorkers} queue workers started`)
  }
  for (const w of input.workers) {
    if (!w.running) problems.push(`queue worker "${w.name}" is not running`)
    else if (w.paused) problems.push(`queue worker "${w.name}" is paused`)
    else if (w.attached === false) problems.push(`queue worker "${w.name}" has not connected to Redis`)
  }
  if (input.schedules !== undefined) {
    const status = input.schedules?.status ?? null
    if (!status) {
      problems.push('recurring schedules not checked (scheduled worker not started)')
    } else if (status.firstPassDone || input.schedules?.bootGraceElapsed) {
      if (!status.firstPassDone) problems.push('recurring schedules not yet verified (first reconcile pass has not completed)')
      for (const name of status.missing) problems.push(`recurring schedule "${name}" is not registered`)
    }
  }
  return { ok: problems.length === 0, problems }
}

/** How long a host with missing configuration keeps serving 503 before exiting. */
export const CONFIG_FAILURE_EXIT_DEFAULT_MS = 120_000

/** A missing schedule is not a readiness problem until the first pass or this long after boot. */
export const SCHEDULE_BOOT_GRACE_MS = 60_000

// ── Error-log rate limiting ─────────────────────────────────────────────
// BullMQ Workers and Queues emit 'error' on every reconnect attempt during a
// Redis outage (every 50ms-2s, per connection, per queue). Logging each one
// buries the one line that matters. One line per distinct message per window,
// with a count of what was suppressed.

export type ErrorLogDecision = { log: boolean; suppressed: number }

export function createErrorLogLimiter(
  windowMs = 60_000,
  maxKeys = 200,
  now: () => number = Date.now,
): (key: string) => ErrorLogDecision {
  const seen = new Map<string, { at: number; suppressed: number }>()
  return (key: string) => {
    const t = now()
    const prev = seen.get(key)
    if (prev && t - prev.at < windowMs) {
      prev.suppressed++
      return { log: false, suppressed: prev.suppressed }
    }
    const suppressed = prev?.suppressed ?? 0
    seen.delete(key)
    seen.set(key, { at: t, suppressed: 0 })
    // Bounded: messages can embed changing details; drop the oldest.
    while (seen.size > maxKeys) {
      const oldest = seen.keys().next().value
      if (oldest === undefined) break
      seen.delete(oldest)
    }
    return { log: true, suppressed }
  }
}

// ── Email delivery readiness (API /api/health) ──────────────────────────
// A quote confirmation the API enqueues is only ever SENT if a worker consumes
// the queue. These three have no fallback consumer:
//   email          — every customer email job;
//   scheduled      — outbox drains, journeys and the recovery sweeps;
//   webhook-retry  — paid-deposit fulfilment (booking flip + confirmation email).
// Discord is reported but not required: lead/approval cards have REST fallbacks
// and do not stop customer email.

export const REQUIRED_EMAIL_QUEUES = ['email', 'scheduled', 'webhook-retry'] as const
export type EmailDeliveryQueue = (typeof REQUIRED_EMAIL_QUEUES)[number] | 'discord'
/** null = unknown (timed out, or Redis unreachable so not asked). */
export type QueueWorkerCounts = Record<EmailDeliveryQueue, number | null>

export type EmailDeliveryVerdict = {
  ready: boolean
  workersAttached: QueueWorkerCounts
  problems: string[]
  notes: string[]
}

const QUEUE_CONSEQUENCE: Record<(typeof REQUIRED_EMAIL_QUEUES)[number], string> = {
  email: 'queued customer email will not be sent',
  scheduled: 'outbox drains, journeys and recovery sweeps will not run',
  'webhook-retry': 'paid deposits will not be fulfilled or confirmed',
}

export function evaluateEmailDelivery(counts: QueueWorkerCounts): EmailDeliveryVerdict {
  const problems: string[] = []
  const notes: string[] = []
  for (const q of REQUIRED_EMAIL_QUEUES) {
    const n = counts[q]
    if (n === null) problems.push(`worker attachment for the "${q}" queue is unknown (not answered in time)`)
    else if (n < 1) problems.push(`no worker attached to the "${q}" queue — ${QUEUE_CONSEQUENCE[q]}`)
  }
  if (counts.discord === 0) notes.push('no worker attached to the "discord" queue — lead/approval cards will wait (informational)')
  return { ready: problems.length === 0, workersAttached: { ...counts }, problems, notes }
}

/**
 * Cache an async observation for ttlMs and share one in-flight load between
 * concurrent callers, so a polled health endpoint cannot multiply Redis or
 * Postgres work. A rejected load is not cached.
 */
export function singleFlightCache<T>(
  load: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
  // Per-VALUE lifetime. A window that answered nothing must not be pinned for
  // the full TTL: one slow CLIENT LIST would hold public readiness at 503 long
  // after Redis recovered. Defaults to the flat TTL, so existing callers are
  // unchanged.
  ttlFor: (value: T) => number = () => ttlMs
): () => Promise<T> {
  let cached: { at: number; ttl: number; value: T } | null = null
  let inFlight: Promise<T> | null = null
  return () => {
    if (cached && now() - cached.at < cached.ttl) return Promise.resolve(cached.value)
    if (inFlight) return inFlight
    inFlight = load()
      .then((value) => {
        cached = { at: now(), ttl: ttlFor(value), value }
        return value
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }
}
