// ════════════════════════════════════════════════════════════════════════
//  RECURRING SCHEDULES — the managed registry and its self-healing reconciler
//  ---------------------------------------------------------------------
//  The scheduled worker used to register its twelve crons ONCE, fire-and-forget,
//  at startup: twelve sequential `await queue.add(...)` calls with no retry and
//  no status. The first rejection skipped every later schedule, a Redis outage
//  made the calls hang instead of fail, and /healthz said "ok" either way. After
//  a Redis flush nothing re-registered them until someone happened to redeploy,
//  so the recovery sweeps that make transactional email durable simply stopped.
//
//  This module owns the list and a reconciler that keeps Redis matching it:
//    • one try/catch, one timeout and bounded retries PER schedule, so a single
//      failure never stops the other eleven being attempted;
//    • a fail-fast Redis PING before any queue call, so an outage does not pile
//      commands into ioredis's offline queue (BullMQ connections never give up);
//    • presence is VERIFIED with getRepeatableJobs(), not assumed from add();
//    • a latched REPAIR (first pass after start, and on request) re-adds every
//      schedule unconditionally, because a repeatable whose next iteration was
//      lost still looks present — see `forceReadd`;
//    • a background loop: quick bounded backoff while anything is missing, then a
//      slow verification pass, so a flushed Redis heals without a redeploy;
//    • a status snapshot that readiness reports by schedule NAME.
//
//  It never exits the process. Railway restarts at most ten times, and a long
//  Redis outage would otherwise end with the email worker permanently down.
//
//  STAYS ON THE LEGACY REPEAT API (queue.add + repeat + jobId). Production Redis
//  holds exactly these twelve legacy entries; BullMQ keys each one on
//  md5(`${name}:${jobId}:${endDate}:${tz}:${pattern}`), so re-adding an identical
//  schedule overwrites the same key instead of creating a second one. Mixing in
//  upsertJobScheduler would create a SECOND entry per name and double-fire every
//  cron. Names, jobIds, patterns and tz below are byte-identical to what is live.
// ════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto'
import type { ScheduledJobData } from './queues'
import { sanitizeRedisError } from './redis-health'

export type CronSchedule = {
  readonly name: ScheduledJobData['type']
  readonly pattern: string
  /** undefined = UTC. BullMQ stores a missing tz as null; both mean the same schedule. */
  readonly tz: string | undefined
  /** Feeds BullMQ's repeat-key hash only; it never becomes a job id. */
  readonly jobId: string
}

// Cron times of day use America/New_York (a digest scheduled in bare UTC would
// arrive an hour early for half the year).
export const CRON_SCHEDULES: ReadonlyArray<CronSchedule> = [
  // 7:00 AM ET → morning digest (today's jobs)
  { name: 'daily-schedule-morning', pattern: '0 7 * * *', tz: 'America/New_York', jobId: 'cron:daily-schedule-morning' },
  // 7:00 PM ET → evening digest (tomorrow's jobs)
  { name: 'daily-schedule-evening', pattern: '0 19 * * *', tz: 'America/New_York', jobId: 'cron:daily-schedule-evening' },

  // ── Email dispatch runtime sweeps (owner spec 2026-07-22) ──
  // Cost rule: recovery/monitoring work shares ONE quarter-hour wake window.
  // Scattering two-, five- and ten-minute Postgres jobs across the hour kept
  // Neon's compute permanently active. Real customer events still run
  // immediately; only safety-net and batch maintenance work waits up to 15m.
  //
  // campaign-sweep: dispatches due SCHEDULED campaigns, re-opens stale
  // recipient claims, re-enqueues lost batches, finalizes settled runs.
  { name: 'campaign-sweep', pattern: '*/15 * * * *', tz: undefined, jobId: 'cron:campaign-sweep' },
  // Lead delivery itself is inline and immediate. This is only the durable
  // recovery path for an interrupted request or Discord outage.
  { name: 'lead-notification-sweep', pattern: '*/15 * * * *', tz: undefined, jobId: 'cron:lead-notification-sweep' },
  // automation-sweep: requeues due stages (restart / un-pause recovery) and
  // evaluates the grounded time-based triggers. Every action is idempotent, so
  // the cadence is a freshness knob rather than a correctness one.
  { name: 'automation-sweep', pattern: '*/15 * * * *', tz: undefined, jobId: 'cron:automation-sweep' },
  // Transactional email is event-driven for normal delivery. This sweep is the
  // durable fallback when the post-commit Redis nudge could not be queued.
  { name: 'outbox-email-recovery', pattern: '*/15 * * * *', tz: undefined, jobId: 'cron:outbox-email-recovery' },
  // Re-drives suppressions that failed to write (audit E-02).
  { name: 'email-side-effect-sweep', pattern: '*/15 * * * *', tz: undefined, jobId: 'cron:email-side-effect-sweep' },
  // Read-only; it repairs nothing, because a monitor that fixes things hides the
  // problem it exists to reveal (audit E-04).
  { name: 'email-monitoring', pattern: '*/15 * * * *', tz: undefined, jobId: 'cron:email-monitoring' },
  // ── Email operations agent (owner spec 2026-07-27, cadence 2026-07-28) ──
  // Registered unconditionally: the cycle reads its own settings and returns
  // immediately when the mode is `off`, so enabling the agent never requires a
  // worker restart. 15 minutes, not 5: a 5-minute cadence produced 288 cycles a
  // day and, before deduplication existed, 288 model calls per open incident.
  { name: 'email-agent-cycle', pattern: '*/15 * * * *', tz: undefined, jobId: 'cron:email-agent-cycle' },

  // ── Daily lead hygiene (owner review 2026-07-24) ──
  // 3:20 AM ET, off-peak: ages inactive partial captures to ABANDONED and
  // applies the retention purge. Idempotent; skips anything quoted, converted,
  // or carrying a consent decision.
  { name: 'lead-maintenance', pattern: '20 3 * * *', tz: 'America/New_York', jobId: 'cron:lead-maintenance' },
  // ── Marketing discovery (owner spec 2026-08-07) ──
  // Daily at 10:05 ET, inside business hours so the owner sees the Discord ask
  // when it can be acted on. Flag-gated inside the job and draft-only; the cron
  // itself is always registered so enabling the agent never needs a restart.
  { name: 'marketing-discovery', pattern: '5 10 * * *', tz: 'America/New_York', jobId: 'cron:marketing-discovery' },
  // ── Stranded lifecycle repair (owner spec 2026-08-07) ──
  // Hourly on the hour, aligned with the quarter-hour wake window. Hourly rather
  // than daily because the condition it repairs is TEMPORARY: when the owner
  // widens the rollout allowlist, leads quoted during the canary should enter
  // their sequence within the hour. Bounded batch; an idle pass is one query.
  { name: 'lifecycle-repair', pattern: '0 * * * *', tz: undefined, jobId: 'cron:lifecycle-repair' },
]

/**
 * The key BullMQ 5.x derives for a legacy repeatable added through
 * queue.add(name, data, { repeat: { pattern, tz }, jobId }) — see bullmq
 * repeat.js getRepeatConcatOptions + hash (md5). Used by tests to model Redis
 * faithfully and by the gated test to prove the model matches real BullMQ.
 */
export function legacyRepeatKey(s: Pick<CronSchedule, 'name' | 'pattern' | 'tz' | 'jobId'>): string {
  return createHash('md5').update(`${s.name}:${s.jobId}::${s.tz || ''}:${s.pattern}`).digest('hex')
}

/** One entry as getRepeatableJobs() returns it. BullMQ can return holes. */
export type RepeatableEntry = { key: string; name?: string | null; pattern?: string | null; tz?: string | null }

/** The subset of a BullMQ Queue the reconciler uses (the real scheduledQueue satisfies it). */
export type CronQueue = {
  add(name: string, data: { type: string }, opts: { repeat: { pattern: string; tz?: string }; jobId: string }): Promise<unknown>
  getRepeatableJobs(): Promise<ReadonlyArray<RepeatableEntry | null | undefined>>
  removeRepeatableByKey(key: string): Promise<unknown>
}

export type CronStatus = {
  /** True when the last verification found every schedule exactly once. */
  ok: boolean
  firstPassDone: boolean
  startedAt: string | null
  lastPassAt: string | null
  lastOkAt: string | null
  nextPassAt: string | null
  expected: number
  registered: string[]
  /** Not verified present (never verified, absent, or duplicated). */
  missing: string[]
  /** Credential-free reasons from the last pass, by schedule name (or 'redis'). */
  lastErrors: { name: string; message: string }[]
}

type Log = {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

export type CronReconcilerOptions = {
  queue: CronQueue
  /** Fail-fast probe (pingAppRedis). False ⇒ the pass makes NO queue call. */
  redisOk: () => Promise<boolean>
  schedules?: ReadonlyArray<CronSchedule>
  logger?: Log
  /** Per queue call. The command may stay queued, which is why PING gates first. */
  callTimeoutMs?: number
  /** add() attempts per schedule within one pass. */
  addAttempts?: number
  addBackoffMs?: number
  /** Loop backoff while anything is missing: min doubling up to max. */
  retryMinMs?: number
  retryMaxMs?: number
  /** Slow re-verification once everything is registered (drift, Redis flush). */
  verifyIntervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export type CronReconciler = {
  /** Run the first pass now and keep the loop going. Idempotent. */
  start(): void
  stop(): void
  /** One pass (single-flight: concurrent callers share the in-flight pass). */
  reconcileOnce(): Promise<CronStatus>
  /**
   * Bring the next pass forward (never pushes it later). `forceReadd` latches a
   * REPAIR: the next pass re-adds every schedule instead of only the absent
   * ones. The latch is set BEFORE every early return, so a repair asked for
   * while a pass is already in flight is honoured by the following pass rather
   * than dropped.
   */
  requestReconcile(delayMs: number, opts?: { forceReadd?: boolean }): void
  status(): CronStatus
}

export const CRON_RETRY_MIN_MS = 5_000
export const CRON_RETRY_MAX_MS = 120_000
export const CRON_VERIFY_INTERVAL_MS = 10 * 60_000
export const CRON_CALL_TIMEOUT_MS = 5_000

class RedisUnavailable extends Error {}

// tz: undefined (desired UTC), null (as BullMQ returns it) and '' are the same
// schedule; BullMQ hashes all three as ''. Treating them as different would
// prune a live UTC schedule on every pass.
const sameSchedule = (r: RepeatableEntry, s: CronSchedule): boolean =>
  r.name === s.name && (r.pattern ?? null) === s.pattern && (r.tz || null) === (s.tz || null)

const messageOf = (err: unknown): string => sanitizeRedisError(err instanceof Error ? err.message : String(err))

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createCronReconciler(opts: CronReconcilerOptions): CronReconciler {
  const schedules = (opts.schedules ?? CRON_SCHEDULES).filter(Boolean)
  const log = opts.logger
  const callTimeoutMs = opts.callTimeoutMs ?? CRON_CALL_TIMEOUT_MS
  const addAttempts = Math.max(1, opts.addAttempts ?? 3)
  const addBackoffMs = opts.addBackoffMs ?? 500
  const retryMinMs = opts.retryMinMs ?? CRON_RETRY_MIN_MS
  const retryMaxMs = opts.retryMaxMs ?? CRON_RETRY_MAX_MS
  const verifyIntervalMs = opts.verifyIntervalMs ?? CRON_VERIFY_INTERVAL_MS
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const setTimer =
    opts.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      // Never keep the process alive just to re-check a schedule.
      t.unref?.()
      return t
    })
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))

  const iso = (ms: number) => new Date(ms).toISOString()
  let current: CronStatus = {
    ok: false,
    firstPassDone: false,
    startedAt: null,
    lastPassAt: null,
    lastOkAt: null,
    nextPassAt: null,
    expected: schedules.length,
    registered: [],
    missing: schedules.map((s) => s.name),
    lastErrors: [],
  }
  let started = false
  let stopped = false
  let timer: unknown = null
  let timerDueAt: number | null = null
  let inFlight: Promise<CronStatus> | null = null
  let consecutiveFailures = 0
  // ── Repair mode: presence is not liveness ──────────────────────────────
  // When BullMQ cannot create a repeatable's NEXT iteration it emits 'Failed to
  // add repeatable job for next iteration' and then schedules nothing further
  // (worker.js nextJobFromJobData), but it leaves the `repeat` ZSET member and
  // the repeat:<key> hash untouched — only the DELAYED job is gone. So
  // getRepeatableJobs() still returns a fully matching entry for a schedule that
  // will never fire again: a presence-only pass can neither see it nor fix it,
  // and readiness would keep reporting it registered.
  //
  // The repair is a plain re-add of the identical schedule. queue.add(name,
  // data, { repeat, jobId }) routes through updateRepeatableJob({override:true})
  // → addRepeatableJob-2.lua, which ZADDs the SAME md5 member (one ZSET entry,
  // so no duplicate schedule), and createNextJob() then recreates the delayed
  // job under the deterministic id repeat:<key>:<nextMillis> computed from the
  // cron pattern — the instant the lost occurrence would have had. Nothing
  // drifts and nothing fires twice.
  //
  // LATCHED, not per-pass: re-adding on every pass would also re-key an
  // occurrence that is merely OVERDUE (due but not yet promoted), and the lua's
  // removal branch would drop that pending run. So the unconditional re-add
  // happens on the FIRST pass only — restoring the boot-time registration the
  // scheduled worker did before this module existed, which is what recreated a
  // lost delayed job on every restart — and whenever a repair is requested.
  let forceReadd = true

  const redisUp = async (): Promise<boolean> => {
    try {
      return (await withTimeout(opts.redisOk(), callTimeoutMs, 'redis PING')) === true
    } catch {
      return false
    }
  }

  const schedule = (delayMs: number) => {
    // Only a started reconciler loops; a bare reconcileOnce() is a single pass.
    if (stopped || !started) return
    if (timer !== null) clearTimer(timer)
    timerDueAt = now() + delayMs
    current = { ...current, nextPassAt: iso(timerDueAt) }
    timer = setTimer(() => {
      timer = null
      timerDueAt = null
      void reconcileOnce()
    }, delayMs)
  }

  async function addWithRetry(s: CronSchedule): Promise<void> {
    let last: unknown
    for (let attempt = 1; attempt <= addAttempts; attempt++) {
      try {
        // The exact call shape production has always used: a UTC schedule carries
        // no tz key at all, and data is { type: name }.
        const repeat = s.tz ? { pattern: s.pattern, tz: s.tz } : { pattern: s.pattern }
        await withTimeout(opts.queue.add(s.name, { type: s.name }, { repeat, jobId: s.jobId }), callTimeoutMs, `add ${s.name}`)
        return
      } catch (err) {
        last = err
        if (attempt === addAttempts) break
        // Re-check before retrying: during an outage each timed-out call is still
        // queued inside ioredis, and retrying blind would only add more.
        if (!(await redisUp())) throw new RedisUnavailable('redis stopped answering PING during registration')
        await sleep(Math.min(addBackoffMs * 2 ** (attempt - 1), 4_000))
      }
    }
    throw last
  }

  function finish(passAt: number, verified: RepeatableEntry[] | null, errors: CronStatus['lastErrors']): CronStatus {
    let registered: string[]
    let missing: string[]
    if (verified) {
      registered = []
      missing = []
      for (const s of schedules) {
        const copies = verified.filter((r) => sameSchedule(r, s)).length
        if (copies === 1) {
          registered.push(s.name)
          continue
        }
        missing.push(s.name)
        if (copies > 1) {
          // Two identical live entries fire twice. Deliberately NOT auto-deleted:
          // only this code registers them, so this needs a human to look.
          errors.push({ name: s.name, message: `${copies} identical schedules present (expected exactly one); not removed automatically` })
        } else if (!errors.some((e) => e.name === s.name)) {
          errors.push({ name: s.name, message: 'not present after registration' })
        }
      }
    } else {
      // Nothing verified this pass: what was verified before stays; everything
      // never verified is missing. A repair this pass may have consumed could
      // not be proven, so re-arm it — a repair is never lost to an outage.
      forceReadd = true
      registered = current.registered.filter((n) => schedules.some((s) => s.name === n))
      missing = schedules.map((s) => s.name).filter((n) => !registered.includes(n))
    }

    const passOk = verified !== null && missing.length === 0 && errors.length === 0
    const wasOk = current.ok
    current = {
      ...current,
      // Verified this pass: ok means every schedule exactly once. Not verified
      // (Redis down): an earlier verification stands, and a host that was never
      // verified stays not-ok. Readiness reports the failed PING separately.
      ok: verified !== null ? missing.length === 0 : current.ok && missing.length === 0,
      firstPassDone: current.firstPassDone || verified !== null,
      lastPassAt: iso(passAt),
      lastOkAt: passOk ? iso(passAt) : current.lastOkAt,
      registered,
      missing,
      lastErrors: errors,
    }

    if (passOk) {
      consecutiveFailures = 0
      if (!wasOk) log?.info({ event: 'worker.cron.registered', registered: registered.length }, `recurring schedules verified (${registered.length}/${schedules.length})`)
      schedule(verifyIntervalMs)
    } else {
      consecutiveFailures++
      const nextRetryMs = Math.min(retryMinMs * 2 ** (consecutiveFailures - 1), retryMaxMs)
      log?.error(
        { event: 'worker.cron.registration_failed', missing, errors, attempt: consecutiveFailures, nextRetryMs },
        missing.length > 0
          ? `recurring schedule NOT registered: ${missing.join(', ')} (retrying in ${Math.round(nextRetryMs / 1000)}s)`
          : `recurring schedule reconcile incomplete (retrying in ${Math.round(nextRetryMs / 1000)}s)`,
      )
      schedule(nextRetryMs)
    }
    return status()
  }

  async function pass(): Promise<CronStatus> {
    const passAt = now()
    const errors: CronStatus['lastErrors'] = []

    // 1) Gate: no queue call unless Redis answers a fail-fast PING right now.
    if (!(await redisUp())) {
      errors.push({ name: 'redis', message: 'redis did not answer PING; no queue call attempted' })
      return finish(passAt, null, errors)
    }

    // 2) What is live.
    let existing: RepeatableEntry[]
    try {
      existing = (await withTimeout(opts.queue.getRepeatableJobs(), callTimeoutMs, 'getRepeatableJobs')).filter(
        (r): r is RepeatableEntry => Boolean(r && typeof r.key === 'string'),
      )
    } catch (err) {
      errors.push({ name: 'getRepeatableJobs', message: messageOf(err) })
      return finish(passAt, null, errors)
    }

    // 3) Per schedule, isolated: add when absent — or unconditionally when a
    //    repair is latched — then prune same-name entries whose pattern or tz
    //    differ. Adding first means a failed add never leaves a name with no
    //    schedule at all. Unmanaged names are never touched.
    //    The latch is taken ONCE here, after the gates above, so a pass that
    //    never reached the queue leaves the repair pending for the next one.
    const force = forceReadd
    forceReadd = false
    let wrote = false
    for (const s of schedules) {
      try {
        const sameName = existing.filter((r) => r.name === s.name)
        if (force || !sameName.some((r) => sameSchedule(r, s))) {
          await addWithRetry(s)
          wrote = true
        }
        for (const stale of sameName.filter((r) => !sameSchedule(r, s))) {
          try {
            await withTimeout(opts.queue.removeRepeatableByKey(stale.key), callTimeoutMs, `remove stale ${s.name}`)
            wrote = true
            log?.warn(
              { event: 'worker.cron.stale_removed', name: s.name, stalePattern: stale.pattern ?? null, staleTz: stale.tz ?? null, desiredPattern: s.pattern, desiredTz: s.tz ?? null },
              'removed a stale recurring schedule',
            )
          } catch (err) {
            errors.push({ name: s.name, message: `stale entry not removed: ${messageOf(err)}` })
          }
        }
      } catch (err) {
        // A latched repair whose add did not land stays pending; without this it
        // would be silently consumed by the pass that failed to apply it.
        if (force) forceReadd = true
        errors.push({ name: s.name, message: messageOf(err) })
        if (err instanceof RedisUnavailable) {
          forceReadd = true
          errors.push({ name: 'redis', message: 'redis stopped answering PING; remaining schedules not attempted this pass' })
          break
        }
      }
    }

    // 4) Verify from Redis, not from the add() results.
    let verified = existing
    if (wrote || errors.length > 0) {
      if (!(await redisUp())) {
        errors.push({ name: 'redis', message: 'redis did not answer PING before verification' })
        return finish(passAt, null, errors)
      }
      try {
        verified = (await withTimeout(opts.queue.getRepeatableJobs(), callTimeoutMs, 'getRepeatableJobs')).filter(
          (r): r is RepeatableEntry => Boolean(r && typeof r.key === 'string'),
        )
      } catch (err) {
        errors.push({ name: 'getRepeatableJobs', message: messageOf(err) })
        return finish(passAt, null, errors)
      }
    }
    return finish(passAt, verified, errors)
  }

  function reconcileOnce(): Promise<CronStatus> {
    if (inFlight) return inFlight
    inFlight = pass()
      .catch((err) => finish(now(), null, [{ name: 'reconciler', message: messageOf(err) }]))
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  function status(): CronStatus {
    return { ...current, registered: [...current.registered], missing: [...current.missing], lastErrors: current.lastErrors.map((e) => ({ ...e })) }
  }

  return {
    start() {
      if (started || stopped) return
      started = true
      current = { ...current, startedAt: iso(now()) }
      void reconcileOnce()
    },
    stop() {
      stopped = true
      if (timer !== null) clearTimer(timer)
      timer = null
      timerDueAt = null
      current = { ...current, nextPassAt: null }
    },
    reconcileOnce,
    requestReconcile(delayMs: number, opts?: { forceReadd?: boolean }) {
      // Latch FIRST: a repair requested while a pass is in flight (exactly when
      // BullMQ's error fires — Redis trouble is also when a pass is most likely
      // running) must be honoured by the next pass, not dropped with the timer.
      if (opts?.forceReadd) forceReadd = true
      if (stopped || !started) return
      if (inFlight) return
      if (timerDueAt !== null && timerDueAt <= now() + delayMs) return
      schedule(delayMs)
    },
    status,
  }
}
