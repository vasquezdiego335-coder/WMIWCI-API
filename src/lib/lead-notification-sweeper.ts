// ════════════════════════════════════════════════════════════════════════
//  lead-notification-sweeper.ts — the thing that makes the outbox durable
//  in practice rather than only on paper.
//
//  A durable row is a promise. Without something that re-drives it, the
//  promise is only kept when a queue job happens to survive — and the whole
//  point of the outbox is the cases where it does not:
//
//    * Redis was down when the lead committed, so the job was never published.
//    * `queue.add` threw and the request had already returned.
//    * Redis was wiped, restarted, or failed over and lost the job.
//    * A worker claimed a row and then died, leaving a lease nobody will
//      release.
//
//  In every one of those the row still says "the owner is owed a message", and
//  nothing was coming to look at it. This does.
//
//  DESIGN RULES
//   1. INDEPENDENT OF REQUEST TRAFFIC. A site with no visitors is exactly when
//      a stuck notification matters most, so this runs on a timer, not on a
//      request path.
//   2. ONE RUNNER AT A TIME, enforced by a PostgreSQL advisory lock rather
//      than by hoping only one process is scheduled. Multiple workers are safe:
//      the losers return immediately.
//   3. BOUNDED. A fixed batch, so a large backlog produces steady progress
//      instead of one enormous transaction — and the result says plainly
//      whether it was truncated.
//   4. IT REPORTS. Scanned, requeued, recovered, failed, oldest-pending age and
//      truncation all come back as numbers a monitor can read. A sweeper whose
//      only output is "done" cannot be trusted.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import { queueLogger } from './logger'
import { NOTIFICATION_STATUS, dedupeKeyFor, releaseStaleClaims } from './lead-notification-outbox'

const log = queueLogger.child({ mod: 'lead-notification-sweeper' })

/** One arbitrary, stable key so every replica competes for the same lock. */
const ADVISORY_LOCK_KEY = 776_1042

/** How long a `sending` row may sit before we assume the worker died. */
export const STALE_LEASE_MS = 5 * 60 * 1000

/** Bounded batch: steady progress beats one enormous transaction. */
export const SWEEP_BATCH = 200

export type SweepResult = {
  ran: boolean
  /** False when another replica held the lock — not an error. */
  skippedLocked?: boolean
  scanned: number
  requeued: number
  staleRecovered: number
  failed: number
  /** True when more work remained than the batch allowed. */
  truncated: boolean
  /** Age in ms of the oldest row still waiting. The number to alert on. */
  oldestPendingMs: number | null
  durationMs: number
}

/**
 * Re-drive everything the queue may have dropped.
 *
 * `publish` is injected so this is testable without Redis and so the caller
 * decides which queue it belongs to.
 */
export async function sweepLeadNotifications(
  publish: (dedupeKey: string) => Promise<void>,
  opts: { now?: Date; batch?: number; staleMs?: number } = {},
): Promise<SweepResult> {
  const started = Date.now()
  const now = opts.now ?? new Date()
  const batch = opts.batch ?? SWEEP_BATCH
  const staleMs = opts.staleMs ?? STALE_LEASE_MS

  //  ONE RUNNER. pg_try_advisory_lock returns immediately rather than queueing,
  //  so a second replica does not pile up waiting.
  const [{ locked }] = await prisma.$queryRawUnsafe<Array<{ locked: boolean }>>(
    `SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS locked`,
  )
  if (!locked) return { ran: false, skippedLocked: true, scanned: 0, requeued: 0, staleRecovered: 0, failed: 0, truncated: false, oldestPendingMs: null, durationMs: Date.now() - started }

  try {
    //  1. A worker that died mid-flight left a lease. Release it WITHOUT
    //     consuming an attempt — the provider was never actually called.
    const staleRecovered = await releaseStaleClaims(new Date(now.getTime() - staleMs), now)

    //  2. Everything genuinely due: never published, or a retry whose time has
    //     come. Ordered oldest-first so a backlog drains fairly.
    const due = await prisma.leadNotification.findMany({
      where: {
        status: { in: [NOTIFICATION_STATUS.pending, NOTIFICATION_STATUS.retry] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: batch + 1, // one extra, purely to detect truncation honestly
      select: { dedupeKey: true, createdAt: true },
    })
    const truncated = due.length > batch
    const work = truncated ? due.slice(0, batch) : due

    let requeued = 0
    let failed = 0
    for (const row of work) {
      try {
        await publish(row.dedupeKey)
        requeued += 1
      } catch (err) {
        //  A publish failure is not fatal: the row stays due and the next sweep
        //  tries again. It IS counted, because a sweeper that cannot publish is
        //  itself an incident.
        failed += 1
        log.warn({ err: String(err).slice(0, 200) }, 'sweeper could not publish a notification')
      }
    }

    const oldest = work[0]?.createdAt ?? null
    const result: SweepResult = {
      ran: true,
      scanned: work.length,
      requeued,
      staleRecovered,
      failed,
      truncated,
      oldestPendingMs: oldest ? now.getTime() - oldest.getTime() : null,
      durationMs: Date.now() - started,
    }
    if (result.scanned || result.staleRecovered) log.info(result, 'lead-notification sweep')
    return result
  } finally {
    await prisma.$queryRawUnsafe(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`)
  }
}

/**
 * The numbers an operator needs, without opening a SQL client.
 *
 * Queryable rows are not monitoring: somebody has to be told. This is the
 * shape a health endpoint or an alert rule consumes.
 */
export type NotificationHealth = {
  pending: number
  retrying: number
  terminal: number
  staleLeases: number
  oldestPendingMs: number | null
  oldestRetryMs: number | null
  /** True when any figure below was capped — see the completeness contract. */
  truncated: boolean
  total: number
}

export async function leadNotificationHealth(
  now: Date = new Date(),
  staleMs: number = STALE_LEASE_MS,
): Promise<NotificationHealth> {
  const CAP = 10_000
  const [pending, retrying, terminal, staleLeases, oldestPending, oldestRetry] = await Promise.all([
    prisma.leadNotification.count({ where: { status: NOTIFICATION_STATUS.pending }, take: CAP } as never),
    prisma.leadNotification.count({ where: { status: NOTIFICATION_STATUS.retry } }),
    prisma.leadNotification.count({ where: { status: NOTIFICATION_STATUS.failedTerminal } }),
    prisma.leadNotification.count({
      where: { status: NOTIFICATION_STATUS.sending, claimedAt: { lt: new Date(now.getTime() - staleMs) } },
    }),
    prisma.leadNotification.findFirst({
      where: { status: NOTIFICATION_STATUS.pending },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.leadNotification.findFirst({
      where: { status: NOTIFICATION_STATUS.retry },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ])
  const total = pending + retrying + terminal + staleLeases
  return {
    pending,
    retrying,
    terminal,
    staleLeases,
    oldestPendingMs: oldestPending ? now.getTime() - oldestPending.createdAt.getTime() : null,
    oldestRetryMs: oldestRetry ? now.getTime() - oldestRetry.createdAt.getTime() : null,
    //  Honest completeness: say so when a count hit its cap rather than letting
    //  a capped number be read as the whole picture.
    truncated: pending >= CAP,
    total,
  }
}

/** The deterministic key, re-exported so schedulers do not re-derive it. */
export { dedupeKeyFor }
