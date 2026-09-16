// ════════════════════════════════════════════════════════════════════════
//  LIFECYCLE RETRY SWEEP (production reliability release 2026-09-15)
//  ---------------------------------------------------------------------
//  The second half of lifecycle-enqueue.ts. Every row in
//  lifecycle_enqueue_retries is a job a live trigger DECIDED to schedule and
//  could not put in Redis. This sweep re-adds exactly that job — same queue,
//  same name, same data, same deterministic job id — and nothing else.
//
//  WHAT IT WILL NOT DO, on purpose:
//    • infer missing work from booking/lead state (rejected: it would email
//      customers who were skipped deliberately);
//    • re-add anything past its row's `not_after` — such a row is abandoned,
//      so an outage can delay a stage within its bound but never replay older
//      history;
//    • touch Redis in any way other than `add` with the row's own job id (no
//      removals, no state reads). While the job exists that add is a BullMQ
//      no-op, so a timed-out live add that landed later is harmless;
//    • delete rows. They are the audit trail of what failed and what happened.
//
//  ELIGIBILITY IS NOT RE-DECIDED HERE. A re-added job runs through the SAME
//  stage handler as an on-time one (scheduled.worker / runFollowup), which
//  re-reads the booking or lead, re-applies consent, suppression and every stop
//  rule, and dedupes on the unchanged idempotency key. Cancelled stages are
//  already closed by the cancel paths (journeyQueueEdge.cancel).
//
//  Runs from the existing hourly 'lifecycle-repair' job. No new cron.
// ════════════════════════════════════════════════════════════════════════

import { queueLogger } from './logger'
import { shiftIntoAllowedHours } from './followups'
import {
  ENQUEUE_TIMEOUT_MS,
  TOO_LATE_REASON,
  defaultRetryStore,
  lifecycleEnqueueCounters,
  shiftForPath,
  timeboxed,
  type LifecyclePath,
  type QueueLike,
  type RetryRow,
  type RetryStore,
} from './lifecycle-enqueue'

const log = queueLogger.child({ mod: 'lifecycle-retry-sweep' })

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Upper bound on the back-off between sweep attempts for one row. */
export const RETRY_BACKOFF_CAP_MS = HOUR

/** Why a row naming a queue this process cannot route was closed. */
export const UNROUTABLE_REASON = 'unroutable: unknown queue'

export type SweepCounts = {
  examined: number
  enqueued: number
  failed: number
  abandonedTooLate: number
  abandonedUnroutable: number
  /** Rows another actor (a cancel) closed between our read and our write. */
  raced: number
}

export type LifecycleRetrySweepDeps = {
  store: RetryStore
  /** The queue a row names, or null when this process cannot route it. */
  queueFor(queueName: string): QueueLike | null
  /** The quiet-hours shift the LIVE path applies for this path. */
  shiftFor(path: LifecyclePath): (d: Date) => Date
  timeoutMs?: number
}

/**
 * PURE: when to look at a row again after a failed re-add. Exponential from one
 * minute, capped at an hour, and never past the row's own bound — so the final
 * attempt happens AT not_after rather than the row being skipped past it.
 */
export function nextRetryAt(attempts: number, now: Date, notAfter: Date): Date {
  const backoff = Math.min(RETRY_BACKOFF_CAP_MS, MINUTE * 2 ** Math.max(0, Math.min(attempts, 20)))
  return new Date(Math.min(now.getTime() + backoff, notAfter.getTime()))
}

/**
 * PURE: the delay for a re-add. The intended fire time is kept when it is still
 * in the future; an overdue stage goes now. Either way the live path's
 * quiet-hours shift is applied, exactly as it was at schedule time.
 */
export function retryDelayMs(row: Pick<RetryRow, 'fireAt'>, now: Date, shift: (d: Date) => Date): number {
  const target = new Date(Math.max(row.fireAt.getTime(), now.getTime()))
  return Math.max(0, shift(target).getTime() - now.getTime())
}

/**
 * The quiet-hours shift each path's LIVE scheduler applies. Post-job follow-ups
 * shift with followups.ts's own window; everything else with the path's shift.
 */
export function sweepShiftFor(path: LifecyclePath): (d: Date) => Date {
  return path === 'post-job-followup' ? shiftIntoAllowedHours : shiftForPath(path)
}

let _defaultDeps: LifecycleRetrySweepDeps | undefined
async function defaultSweepDeps(): Promise<LifecycleRetrySweepDeps> {
  if (_defaultDeps) return _defaultDeps
  // Lazy: importing the sweep must never construct a queue.
  //
  // The row's queue_name is the literal its caller passed to enqueueDurable, so
  // this map is the ONLY thing that turns it back into a queue. An unrecognised
  // name is an error (abandonedUnroutable + log.error below) and never a
  // default: routing a discord/marketing job onto `scheduled` would hand it to a
  // worker whose dispatch warns "unknown job type" and then COMPLETES it, which
  // reports the row as repaired while the card is silently gone.
  const queues = await import('./queues')
  const byName: Record<string, QueueLike> = {
    scheduled: queues.scheduledQueue,
    email: queues.emailQueue,
    discord: queues.discordQueue,
    marketing: queues.marketingQueue,
  }
  _defaultDeps = {
    store: defaultRetryStore(),
    queueFor: (name) => byName[name] ?? null,
    shiftFor: sweepShiftFor,
  }
  return _defaultDeps
}

let lastSweepAt: Date | null = null
let lastSweepCounts: SweepCounts | null = null

/**
 * Re-add due retry rows. Bounded, idempotent, never throws for a single row.
 * A store read failure propagates (the hourly job records it as failed).
 */
export async function runLifecycleRetrySweep(
  opts: { limit?: number; now?: Date; deps?: LifecycleRetrySweepDeps } = {}
): Promise<SweepCounts> {
  const now = opts.now ?? new Date()
  const limit = opts.limit ?? 100
  const deps = opts.deps ?? (await defaultSweepDeps())
  const counts: SweepCounts = { examined: 0, enqueued: 0, failed: 0, abandonedTooLate: 0, abandonedUnroutable: 0, raced: 0 }

  const rows = await deps.store.due(now, limit)
  for (const row of rows) {
    counts.examined++
    const ctx = { retryId: row.id, path: row.path, jobId: row.jobId, queue: row.queueName, subjectType: row.subjectType, subjectId: row.subjectId }
    try {
      // (1) Past its bound: close it. Never re-add old history.
      if (now.getTime() > row.notAfter.getTime()) {
        if (await deps.store.markAbandoned(row.id, TOO_LATE_REASON, now)) {
          counts.abandonedTooLate++
          log.error({ ...ctx, notAfter: row.notAfter.toISOString(), attempts: row.attempts }, 'lifecycle retry ABANDONED — past its lateness bound, not re-enqueued')
        } else counts.raced++
        continue
      }

      // (2) A queue this process cannot route can never succeed.
      const queue = deps.queueFor(row.queueName)
      if (!queue) {
        if (await deps.store.markAbandoned(row.id, UNROUTABLE_REASON, now)) {
          counts.abandonedUnroutable++
          log.error(ctx, 'lifecycle retry ABANDONED — unknown queue')
        } else counts.raced++
        continue
      }

      // (3) Re-add the SAME job under the SAME id.
      const delay = retryDelayMs(row, now, deps.shiftFor(row.path))
      let error: string | null = null
      try {
        const added = await timeboxed(
          queue.add(row.jobName, row.data, { delay, jobId: row.jobId }),
          deps.timeoutMs ?? ENQUEUE_TIMEOUT_MS,
          'queue.add'
        )
        if (added === false) error = 'queue.add returned false'
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }

      if (error === null) {
        if (await deps.store.markEnqueued(row.id, now)) {
          counts.enqueued++
          log.warn({ ...ctx, delayMs: delay, attempts: row.attempts }, 'lifecycle retry re-enqueued a job whose live enqueue had failed')
        } else {
          // Closed by a cancel between our read and the add. The stage handler
          // re-checks the subject when the job runs, so this cannot mis-send.
          counts.raced++
          log.warn(ctx, 'lifecycle retry row was closed while re-adding — the stage handler rechecks at run time')
        }
        continue
      }

      counts.failed++
      const next = nextRetryAt(row.attempts, now, row.notAfter)
      await deps.store.markAttemptFailed(row.id, error, next)
      log.warn({ ...ctx, err: error, nextAttemptAt: next.toISOString() }, 'lifecycle retry re-add failed — will try again')
    } catch (err) {
      // One row's store write failing must not stop the rest of the batch.
      counts.failed++
      log.error({ ...ctx, err: err instanceof Error ? err.message : String(err) }, 'lifecycle retry row could not be processed')
    }
  }

  lastSweepAt = now
  lastSweepCounts = counts
  return counts
}

export type LifecycleRetryMetrics = {
  pending: number
  enqueued: number
  abandoned: number
  /** In-process only: a lost enqueue by definition has no row. */
  lost: number
  lastSweepAt: string | null
  lastSweepCounts: SweepCounts | null
}

/** Metrics for health endpoints and logs. No addresses, no job data. */
export async function lifecycleRetryMetrics(store: RetryStore = defaultRetryStore(), now: Date = new Date()): Promise<LifecycleRetryMetrics> {
  const s = await store.summary(now)
  return {
    pending: s.pending,
    enqueued: s.enqueued,
    abandoned: s.abandoned,
    lost: lifecycleEnqueueCounters().lost,
    lastSweepAt: lastSweepAt ? lastSweepAt.toISOString() : null,
    lastSweepCounts,
  }
}
