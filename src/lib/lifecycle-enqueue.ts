// ════════════════════════════════════════════════════════════════════════
//  DURABLE LIFECYCLE ENQUEUE (production reliability release 2026-09-15)
//  ---------------------------------------------------------------------
//  THE DEFECT THIS CLOSES. Every lifecycle scheduler — abandoned checkout,
//  pre-move reminders, the balance reminder, lead nurture, quote follow-ups,
//  post-job follow-ups and the payment-step fan-out — raced `queue.add` against
//  a 5s timeout, logged the failure as "non-fatal", and then logged
//  "scheduled" anyway. A Redis stall at the wrong moment deleted a customer's
//  whole sequence and left a log line saying it existed. Nothing ever looked
//  at that work again.
//
//  THE DESIGN: A DURABLE RETRY RECORD, NOT STATE INFERENCE. When an add does
//  not succeed, the EXACT job we meant to add (queue, name, data, deterministic
//  job id, intended fire time) is written to `lifecycle_enqueue_retries`. The
//  hourly lifecycle-repair sweep (lifecycle-retry-sweep.ts) re-adds that same
//  job under the same id. It never guesses what "should" exist from booking or
//  lead state — that approach was rejected because it would email customers who
//  were skipped ON PURPOSE (Discord-completed bookings, reminders skipped at a
//  late confirmation, a duplicate checkout after paying its sibling). Only work
//  a live trigger actually decided to schedule is ever retried.
//
//  WHY A LATE SUCCESS IS HARMLESS. A timed-out add may still land in Redis. The
//  sweep's re-add uses the same job id, which BullMQ treats as a no-op while the
//  job exists, and every stage/email handler re-checks eligibility and dedupes
//  on its unchanged idempotency key.
//
//  WHY THERE IS A `not_after`. Each row carries a path-specific lateness bound
//  computed when it is recorded. Past it the row is abandoned, never re-added:
//  this bounds the retry of work that failed to enqueue, and can never replay
//  older history. See `retryWindowFor` for the policy.
//
//  THREE HONEST OUTCOMES, and callers must log exactly these:
//    scheduled           the add succeeded
//    recorded_for_retry  the add failed; the retry row is durable
//    lost                the add failed AND the retry row could not be written
//                        (error tag LIFECYCLE_ENQUEUE_LOST, counted in-process)
//  No log line in this module carries a recipient address.
// ════════════════════════════════════════════════════════════════════════

import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from './db'
import { nextAllowedTime } from './email-guard'
import { queueLogger } from './logger'

const log = queueLogger.child({ mod: 'lifecycle-enqueue' })

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Same bound the live paths always used: a Redis stall must not hang a request. */
export const ENQUEUE_TIMEOUT_MS = 5000
/** The retry-row write is time-boxed too — a pooler stall must not hang a request either. */
export const RETRY_WRITE_TIMEOUT_MS = 5000

/** The error tag an operator greps for when work was genuinely lost. */
export const LIFECYCLE_ENQUEUE_LOST = 'LIFECYCLE_ENQUEUE_LOST'

/** Why a cancelled stage's row was closed. The health check ignores these. */
export const CANCELLED_REASON = 'cancelled'
/** Why a row past its lateness bound was closed. The health check pages on these. */
export const TOO_LATE_REASON = 'too_late: not re-enqueued (no historical replay)'

export const LIFECYCLE_PATHS = [
  'abandoned-checkout',
  'pre-move',
  'balance',
  'lead-nurture',
  'quote-journey',
  'post-job-followup',
  'payment-fanout',
] as const
export type LifecyclePath = (typeof LIFECYCLE_PATHS)[number]

export type RetrySubjectType = 'booking' | 'lead'

export type EnqueueStatus = 'scheduled' | 'recorded_for_retry' | 'lost'
export type EnqueueResult = { status: EnqueueStatus }

/** The only queue surface this module needs. BullMQ's Queue satisfies it. */
export interface QueueLike {
  readonly name: string
  add(name: string, data: unknown, opts?: { delay?: number; jobId?: string }): Promise<unknown>
}

// ════════════════════════════════════════════════════════════════════════
//  not_after POLICY — how late a failed enqueue may still be retried.
//  ---------------------------------------------------------------------
//  Measured from the stage's INTENDED fire time (before any quiet-hours shift).
//  The bound is about whether the message is still truthful and useful, not
//  about Redis:
//    abandoned stage 1       +3h   "finish your booking" is a fast-follow
//    abandoned stages 2/3    +12h
//    pre-move 72h reminder   +12h  (and never after the move starts)
//    pre-move 24h reminder   +6h   (and never after the move starts) — the copy
//                                  says "tomorrow"
//    balance reminder        +48h
//    lead nurture            +12h
//    quote follow-ups        +24h
//    post-job follow-ups     +72h
//    payment fan-out         +24h  (transactional: approval card, job channels,
//                                  marketing enroll, legacy pre-approval email)
// ════════════════════════════════════════════════════════════════════════

const STAGE_POLICY: Record<string, { path: LifecyclePath; lateMs: number; beforeMoveMs?: number }> = {
  'abandoned-checkout-recovery': { path: 'abandoned-checkout', lateMs: 3 * HOUR },
  'abandoned-checkout-recovery-2': { path: 'abandoned-checkout', lateMs: 12 * HOUR },
  'abandoned-checkout-recovery-3': { path: 'abandoned-checkout', lateMs: 12 * HOUR },
  // A reminder's fire time is move − offset, so "never after the move starts"
  // is fireAt + offset. The lateness bound is always the tighter of the two.
  'job-reminder-72h': { path: 'pre-move', lateMs: 12 * HOUR, beforeMoveMs: 72 * HOUR },
  'job-reminder-24h': { path: 'pre-move', lateMs: 6 * HOUR, beforeMoveMs: 24 * HOUR },
  'balance-reminder-post': { path: 'balance', lateMs: 48 * HOUR },
  'lead-nurture-1': { path: 'lead-nurture', lateMs: 12 * HOUR },
  'lead-nurture-2': { path: 'lead-nurture', lateMs: 12 * HOUR },
  'lead-nurture-final': { path: 'lead-nurture', lateMs: 12 * HOUR },
  'quote-followup-1': { path: 'quote-journey', lateMs: 24 * HOUR },
  'quote-followup-2': { path: 'quote-journey', lateMs: 24 * HOUR },
  'quote-followup-final': { path: 'quote-journey', lateMs: 24 * HOUR },
  'review-request': { path: 'post-job-followup', lateMs: 72 * HOUR },
  'review-reminder': { path: 'post-job-followup', lateMs: 72 * HOUR },
  'referral-ask': { path: 'post-job-followup', lateMs: 72 * HOUR },
  'repeat-reminder': { path: 'post-job-followup', lateMs: 72 * HOUR },
}

/** Transactional payment-step fan-out lateness bound. */
export const PAYMENT_FANOUT_RETRY_WINDOW_MS = 24 * HOUR

/**
 * PURE: the path and lateness bound for a scheduled-queue stage, or null for a
 * job type this policy does not cover (the caller then fails loudly rather than
 * inventing a bound).
 */
export function retryWindowFor(stage: string, fireAt: Date): { path: LifecyclePath; notAfter: Date } | null {
  const p = STAGE_POLICY[stage]
  if (!p) return null
  let notAfter = fireAt.getTime() + p.lateMs
  if (p.beforeMoveMs !== undefined) notAfter = Math.min(notAfter, fireAt.getTime() + p.beforeMoveMs)
  return { path: p.path, notAfter: new Date(notAfter) }
}

/**
 * The quiet-hours shift the LIVE path applies for a path. Journey stages shift
 * through the send guard's window at schedule time; the payment fan-out is
 * immediate. (Post-job follow-ups use followups.ts's own shift, which the
 * follow-up call sites and the sweep pass explicitly.)
 */
export function shiftForPath(path: LifecyclePath): (d: Date) => Date {
  return path === 'payment-fanout' ? (d) => d : (d) => nextAllowedTime(d)
}

// ════════════════════════════════════════════════════════════════════════
//  THE RETRY STORE
// ════════════════════════════════════════════════════════════════════════

export type RetryRecordInput = {
  queueName: string
  jobName: string
  jobId: string
  data: Record<string, unknown>
  fireAt: Date
  notAfter: Date
  path: LifecyclePath
  subjectType: RetrySubjectType
  subjectId: string
}

export type RetryRow = RetryRecordInput & {
  id: string
  status: string
  attempts: number
  lastError: string | null
  nextAttemptAt: Date
  createdAt: Date
  updatedAt: Date
  resolvedAt: Date | null
}

export type RetrySummary = {
  pending: number
  enqueued: number
  abandoned: number
  /** Pending rows created more than 2h / 6h ago. */
  pendingOlderThan2h: number
  pendingOlderThan6h: number
  /** Rows closed in the last 24h for any reason OTHER than a cancellation. */
  abandonedLast24h: number
}

export interface RetryStore {
  /** Upsert by job id: one row per deterministic job, however many failures. */
  recordFailure(input: RetryRecordInput, error: string, now: Date): Promise<void>
  /** Close rows for these job ids (a cancelled stage must never be re-added). */
  abandonForJobIds(jobIds: string[], reason: string, now: Date): Promise<number>
  /** Pending rows due now, oldest first. */
  due(now: Date, limit: number): Promise<RetryRow[]>
  markEnqueued(id: string, now: Date): Promise<boolean>
  markAbandoned(id: string, reason: string, now: Date): Promise<boolean>
  markAttemptFailed(id: string, error: string, nextAttemptAt: Date): Promise<boolean>
  summary(now: Date): Promise<RetrySummary>
}

/** The Prisma surface the store uses — narrow, so an in-memory fake can stand in. */
export type RetryPrismaClient = { lifecycleEnqueueRetry: Pick<PrismaClient['lifecycleEnqueueRetry'], 'create' | 'updateMany' | 'findMany' | 'count'> }

const clip = (s: string) => s.slice(0, 500)

/**
 * The production store. Every write is a single statement, so no interactive
 * transaction is needed on the PgBouncer pooler.
 *
 * UPSERT BY job_id. `create` first; a unique violation (P2002) means a row for
 * this deterministic job already exists, and it is then updated in place:
 *   • pending / abandoned → back to pending with the NEW intent (fire time,
 *     bound, data). An abandoned row here was closed by a cancel; a later live
 *     re-schedule that fails is new work and must be retried.
 *   • enqueued → stays enqueued (only attempts/last_error move). The sweep
 *     already put this exact job in Redis; flipping it back would re-add a job
 *     that may have run. A cancel closes enqueued rows too, so a genuine
 *     re-schedule after a cancel takes the branch above.
 * Two concurrent failures for one job id therefore produce ONE row.
 */
export function prismaRetryStore(client: RetryPrismaClient = prisma): RetryStore {
  const d = client.lifecycleEnqueueRetry
  return {
    async recordFailure(input, error, now) {
      const intent = {
        queueName: input.queueName,
        jobName: input.jobName,
        data: input.data as Prisma.InputJsonValue,
        fireAt: input.fireAt,
        notAfter: input.notAfter,
        path: input.path,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      }
      try {
        await d.create({
          data: { ...intent, jobId: input.jobId, status: 'pending', attempts: 1, lastError: clip(error), nextAttemptAt: now },
        })
        return
      } catch (err) {
        if ((err as { code?: string })?.code !== 'P2002') throw err
      }
      const repended = await d.updateMany({
        where: { jobId: input.jobId, status: { in: ['pending', 'abandoned'] } },
        data: { ...intent, status: 'pending', attempts: { increment: 1 }, lastError: clip(error), nextAttemptAt: now, resolvedAt: null },
      })
      if (repended.count > 0) return
      await d.updateMany({
        where: { jobId: input.jobId, status: 'enqueued' },
        data: { attempts: { increment: 1 }, lastError: clip(error) },
      })
    },
    async abandonForJobIds(jobIds, reason, now) {
      if (jobIds.length === 0) return 0
      const r = await d.updateMany({
        where: { jobId: { in: jobIds }, status: { in: ['pending', 'enqueued'] } },
        data: { status: 'abandoned', lastError: clip(reason), resolvedAt: now },
      })
      return r.count
    },
    async due(now, limit) {
      const rows = await d.findMany({
        where: { status: 'pending', nextAttemptAt: { lte: now } },
        orderBy: { nextAttemptAt: 'asc' },
        take: limit,
      })
      return rows.map((r) => ({
        ...r,
        data: (r.data ?? {}) as Record<string, unknown>,
        path: r.path as LifecyclePath,
        subjectType: r.subjectType as RetrySubjectType,
      }))
    },
    async markEnqueued(id, now) {
      const r = await d.updateMany({ where: { id, status: 'pending' }, data: { status: 'enqueued', resolvedAt: now } })
      return r.count > 0
    },
    async markAbandoned(id, reason, now) {
      const r = await d.updateMany({
        where: { id, status: 'pending' },
        data: { status: 'abandoned', lastError: clip(reason), resolvedAt: now },
      })
      return r.count > 0
    },
    async markAttemptFailed(id, error, nextAttemptAt) {
      const r = await d.updateMany({
        where: { id, status: 'pending' },
        data: { attempts: { increment: 1 }, lastError: clip(error), nextAttemptAt },
      })
      return r.count > 0
    },
    async summary(now) {
      const t = now.getTime()
      const [pending, enqueued, abandoned, pendingOlderThan2h, pendingOlderThan6h, abandonedLast24h] = await Promise.all([
        d.count({ where: { status: 'pending' } }),
        d.count({ where: { status: 'enqueued' } }),
        d.count({ where: { status: 'abandoned' } }),
        d.count({ where: { status: 'pending', createdAt: { lt: new Date(t - 2 * HOUR) } } }),
        d.count({ where: { status: 'pending', createdAt: { lt: new Date(t - 6 * HOUR) } } }),
        d.count({
          where: {
            status: 'abandoned',
            resolvedAt: { gte: new Date(t - 24 * HOUR) },
            NOT: { lastError: { startsWith: CANCELLED_REASON } },
          },
        }),
      ])
      return { pending, enqueued, abandoned, pendingOlderThan2h, pendingOlderThan6h, abandonedLast24h }
    },
  }
}

let _store: RetryStore | undefined
export function defaultRetryStore(): RetryStore {
  if (!_store) _store = prismaRetryStore()
  return _store
}

// ════════════════════════════════════════════════════════════════════════
//  IN-PROCESS COUNTERS — for health and logs. `lost` can only be counted in
//  memory: by definition the database refused to hold it.
// ════════════════════════════════════════════════════════════════════════

const counters = { scheduled: 0, recordedForRetry: 0, lost: 0 }

export function lifecycleEnqueueCounters(): Readonly<typeof counters> {
  return { ...counters }
}

/** Test-only. */
export function resetLifecycleEnqueueCounters(): void {
  counters.scheduled = 0
  counters.recordedForRetry = 0
  counters.lost = 0
}

/** Race a promise against a timeout, clearing the timer either way. */
export function timeboxed<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

// ════════════════════════════════════════════════════════════════════════
//  enqueueDurable
// ════════════════════════════════════════════════════════════════════════

export type DurableEnqueueInput = {
  queue: QueueLike
  /** BullMQ job name. */
  name: string
  /** The job data EXACTLY as the worker should receive it. */
  data: Record<string, unknown>
  /** The deterministic job id — the dedupe key at the queue. */
  jobId: string
  /** Intended run time, before any quiet-hours shift. */
  fireAt: Date
  /** Never re-enqueue after this instant. */
  notAfter: Date
  path: LifecyclePath
  subjectType: RetrySubjectType
  subjectId: string
}

export type DurableEnqueueEdge = {
  store?: RetryStore
  now?: () => Date
  timeoutMs?: number
  /** The live path's quiet-hours shift. Defaults to `shiftForPath(path)`. */
  shift?: (d: Date) => Date
}

/**
 * Add a lifecycle job, or durably record that it must be retried. Never throws.
 */
export async function enqueueDurable(input: DurableEnqueueInput, edge: DurableEnqueueEdge = {}): Promise<EnqueueResult> {
  const now = edge.now ? edge.now() : new Date()
  const shift = edge.shift ?? shiftForPath(input.path)
  const delay = Math.max(0, shift(input.fireAt).getTime() - now.getTime())

  let failure: string
  try {
    const added = await timeboxed(
      input.queue.add(input.name, input.data, { delay, jobId: input.jobId }),
      edge.timeoutMs ?? ENQUEUE_TIMEOUT_MS,
      'queue.add'
    )
    if (added !== false) {
      counters.scheduled++
      return { status: 'scheduled' }
    }
    failure = 'queue.add returned false'
  } catch (err) {
    failure = errText(err)
  }

  // Resolve the queue name defensively: a lazily-constructed queue that could
  // not be built must still leave a row the sweep can route.
  let queueName: string
  try {
    queueName = input.queue.name
  } catch {
    queueName = 'scheduled'
  }

  const logCtx = { path: input.path, jobId: input.jobId, queue: queueName, subjectType: input.subjectType, subjectId: input.subjectId }
  try {
    await timeboxed(
      (edge.store ?? defaultRetryStore()).recordFailure(
        {
          queueName,
          jobName: input.name,
          jobId: input.jobId,
          data: input.data,
          fireAt: input.fireAt,
          notAfter: input.notAfter,
          path: input.path,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
        },
        failure,
        now
      ),
      edge.timeoutMs ?? RETRY_WRITE_TIMEOUT_MS,
      'retry record write'
    )
    counters.recordedForRetry++
    log.warn({ ...logCtx, err: failure }, 'lifecycle enqueue failed — recorded for retry by lifecycle-repair')
    return { status: 'recorded_for_retry' }
  } catch (err) {
    counters.lost++
    log.error(
      { ...logCtx, tag: LIFECYCLE_ENQUEUE_LOST, err: failure, recordErr: errText(err) },
      `${LIFECYCLE_ENQUEUE_LOST}: lifecycle enqueue failed and the retry record could not be written`
    )
    return { status: 'lost' }
  }
}

// ════════════════════════════════════════════════════════════════════════
//  SUMMARIES — one truthful log line per trigger
// ════════════════════════════════════════════════════════════════════════

export type ScheduleSummary = { scheduled: number; recordedForRetry: number; lost: number; skipped: number }

export const emptySummary = (): ScheduleSummary => ({ scheduled: 0, recordedForRetry: 0, lost: 0, skipped: 0 })

/**
 * Normalise what an enqueue dependency resolved. Older injected test worlds
 * resolve a boolean or nothing: `false` there means "not queued, and nothing
 * recorded it", which is `lost`.
 */
export function enqueueStatusOf(r: EnqueueResult | boolean | void | undefined): EnqueueStatus {
  if (r === false) return 'lost'
  if (r && typeof r === 'object') return r.status
  return 'scheduled'
}

export function tally(summary: ScheduleSummary, status: EnqueueStatus): ScheduleSummary {
  if (status === 'scheduled') summary.scheduled++
  else if (status === 'recorded_for_retry') summary.recordedForRetry++
  else summary.lost++
  return summary
}

type Loggerish = {
  info: (obj: object, msg: string) => void
  warn: (obj: object, msg: string) => void
  error: (obj: object, msg: string) => void
}

/**
 * Log a trigger's outcome truthfully. "scheduled" is said ONLY when every
 * attempted stage was scheduled.
 */
export function logScheduleSummary(logger: Loggerish, ctx: Record<string, unknown>, label: string, s: ScheduleSummary): void {
  const fields = { ...ctx, ...s }
  if (s.lost > 0) {
    logger.error({ ...fields, tag: LIFECYCLE_ENQUEUE_LOST }, `${label} NOT fully scheduled — ${s.lost} LOST (retry record could not be written)`)
  } else if (s.recordedForRetry > 0) {
    logger.warn(fields, `${label} NOT fully scheduled — ${s.recordedForRetry} recorded for retry by lifecycle-repair`)
  } else if (s.scheduled > 0) {
    logger.info(fields, `${label} scheduled`)
  } else {
    logger.info(fields, `${label}: nothing to schedule`)
  }
}
