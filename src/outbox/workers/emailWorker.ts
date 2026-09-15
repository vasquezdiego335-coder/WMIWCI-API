import 'dotenv/config'
import {
  fetchPendingJobs,
  markJobSent,
  markJobFailed,
  markJobSkipped,
  markJobDeferred,
  markJobTerminalFailure,
  reapStaleProcessingJobs,
} from '../db/emailJobsRepo'
import { EmailJob, EventType } from '../domain/events'
import {
  sendPreApprovalEmail,
  sendFinalConfirmationEmail,
  sendRescheduleRequestEmail,
  sendDatePickedEmail,
  OutboxRetryLater,
  type OutboxDelivery,
} from '../services/emailService'

// ════════════════════════════════════════════════════════════════════════
//  Outbox worker — polls email_jobs and sends. Safe to run as many instances
//  as you like: fetchPendingJobs claims rows with FOR UPDATE SKIP LOCKED, so no
//  two workers ever process the same row. Run: tsx src/outbox/workers/emailWorker.ts
// ════════════════════════════════════════════════════════════════════════

// Standalone compatibility mode only. Production's combined worker host uses
// event-driven BullMQ nudges plus an aligned recovery cron instead of polling.
// Keep this safely above Neon's default five-minute idle window so accidentally
// launching `outbox:start` cannot recreate the always-on compute bill.
const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_MS ?? 15 * 60 * 1000)
const BATCH = Number(process.env.OUTBOX_BATCH ?? 20)
const SEND_DATE_PICKED_EMAIL = process.env.OUTBOX_SEND_DATE_PICKED === 'true'
// A job stuck in 'processing' longer than this (a crashed worker) is requeued.
const STALE_PROCESSING_MS = Number(process.env.OUTBOX_STALE_PROCESSING_MS ?? 5 * 60 * 1000)
const REAP_INTERVAL_MS = Math.max(30_000, Math.floor(STALE_PROCESSING_MS / 2))

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
let running = true
let lastReapAt = 0

/** Map an event to its email. NEW_DATE_PICKED is optional (the controller
 *  already posts a fresh approval card). */
async function routeAndSend(job: EmailJob): Promise<OutboxDelivery> {
  switch (job.eventType) {
    case EventType.PAYMENT_COMPLETED:
      return sendPreApprovalEmail(job.payload as any)
    case EventType.APPROVED:
      return sendFinalConfirmationEmail(job.payload as any)
    case EventType.RESCHEDULE_REQUESTED:
      return sendRescheduleRequestEmail(job.payload as any)
    case EventType.NEW_DATE_PICKED:
      if (SEND_DATE_PICKED_EMAIL) return sendDatePickedEmail(job.payload as any)
      // Recorded as SKIPPED, never as sent: no email left this system.
      return { status: 'skipped', reason: 'date_picked_email_disabled' }
    default:
      throw new Error(`Unknown event type: ${job.eventType}`)
  }
}

export type OutboxJobDeps = {
  routeAndSend: (job: EmailJob) => Promise<OutboxDelivery>
  markJobSent: typeof markJobSent
  markJobSkipped: typeof markJobSkipped
  markJobDeferred: typeof markJobDeferred
  markJobFailed: typeof markJobFailed
  markJobTerminalFailure: typeof markJobTerminalFailure
}

const defaultJobDeps: OutboxJobDeps = {
  routeAndSend,
  markJobSent,
  markJobSkipped,
  markJobDeferred,
  markJobFailed,
  markJobTerminalFailure,
}

/**
 * Resolve ONE claimed job to its truthful state. Never throws: one bad row
 * (malformed payload, render error, DB blip) is recorded against that row and
 * the batch moves on to the next.
 */
export async function resolveOutboxJob(job: EmailJob, deps: OutboxJobDeps = defaultJobDeps): Promise<OutboxDelivery['status'] | 'retry' | 'held'> {
  const tag = `${job.eventType} job=${job.id} booking=${job.bookingId}`
  try {
    const result = await deps.routeAndSend(job)
    switch (result.status) {
      case 'sent':
        await deps.markJobSent(job, result.note)
        console.log(`[outbox] sent ${tag}${result.note ? ` (${result.note})` : ''}`)
        return 'sent'
      case 'skipped':
        await deps.markJobSkipped(job, result.reason)
        console.log(`[outbox] skipped ${tag}: ${result.reason}`)
        return 'skipped'
      case 'ambiguous':
        await deps.markJobTerminalFailure(
          job,
          `ambiguous:${result.reason} — the provider may have accepted this email; never auto-resent, reconcile against email_sends/Resend`
        )
        console.error(`[outbox] AMBIGUOUS ${tag}: closed without retry`)
        return 'ambiguous'
      case 'failed':
        await deps.markJobTerminalFailure(job, `failed:${result.reason}`)
        console.error(`[outbox] FAILED (terminal) ${tag}: ${result.reason}`)
        return 'failed'
    }
  } catch (err) {
    try {
      if (err instanceof OutboxRetryLater && !err.consumeAttempt) {
        await deps.markJobDeferred(job, err.reason, err.retryAt ?? new Date(Date.now() + 15 * 60_000))
        console.warn(`[outbox] HELD ${tag}: ${err.reason}`)
        return 'held'
      }
      const msg = err instanceof Error ? err.message : String(err)
      await deps.markJobFailed(job, msg, err instanceof OutboxRetryLater ? err.retryAt : null)
      console.error(`[outbox] attempt failed ${tag} attempt=${job.attempts}/${job.maxAttempts}: ${msg}`)
    } catch (markErr) {
      // The row stays 'processing'; the reaper returns it to pending (or closes
      // it on its final attempt) after OUTBOX_STALE_PROCESSING_MS.
      console.error(`[outbox] could not record the outcome of ${tag}:`, markErr instanceof Error ? markErr.message : markErr)
    }
    return 'retry'
  }
  return 'retry'
}

/** One poll cycle: claim due jobs and process each. Returns how many it claimed. */
export async function processOnce(): Promise<number> {
  const jobs = await fetchPendingJobs(BATCH)
  for (const job of jobs) {
    await resolveOutboxJob(job)
  }
  return jobs.length
}

/** Requeue stale 'processing' jobs, throttled to REAP_INTERVAL_MS. */
async function maybeReap(force = false): Promise<number> {
  if (!force && Date.now() - lastReapAt < REAP_INTERVAL_MS) return 0
  lastReapAt = Date.now()
  try {
    const reaped = await reapStaleProcessingJobs(STALE_PROCESSING_MS)
    if (reaped > 0) console.warn(`[outbox] reaper recovered ${reaped} job(s) (requeued, or closed as failed — see the breakdown above)`)
    return reaped
  } catch (err) {
    console.error('[outbox] reaper error:', err)
    return 0
  }
}

/**
 * Drain all currently-due email jobs in bounded batches.
 *
 * Called by two event-driven paths in scheduled.worker.ts:
 *   1. immediately after a real outbox event commits;
 *   2. every aligned recovery interval in case that nudge was lost.
 *
 * The bound prevents a corrupt or enormous backlog from monopolising the
 * scheduled worker. A later recovery pass continues where this one stopped.
 */
export async function drainOutbox(
  maxBatches = 10,
): Promise<{ processed: number; batches: number; reaped: number; truncated: boolean }> {
  const reaped = await maybeReap(true)
  let processed = 0
  let batches = 0

  while (batches < maxBatches) {
    const claimed = await processOnce()
    batches += 1
    processed += claimed
    if (claimed < BATCH) {
      return { processed, batches, reaped, truncated: false }
    }
  }

  return { processed, batches, reaped, truncated: true }
}

async function loop(): Promise<void> {
  console.log(
    `[outbox] worker started (poll=${POLL_INTERVAL_MS}ms batch=${BATCH} staleReap=${STALE_PROCESSING_MS}ms)`
  )
  await maybeReap(true) // reap once at startup before claiming anything
  while (running) {
    try {
      await maybeReap()
      const processed = await processOnce()
      if (processed === 0) await sleep(POLL_INTERVAL_MS) // idle backoff
    } catch (err) {
      console.error('[outbox] poll cycle error:', err)
      await sleep(POLL_INTERVAL_MS)
    }
  }
  console.log('[outbox] worker stopped')
}

function shutdown(signal: string) {
  console.log(`[outbox] ${signal} — finishing current cycle…`)
  running = false
}

/** Start the compatibility poller from another entrypoint. Production's
 *  combined host intentionally does not call this; see drainOutbox(). */
export function startOutboxWorker(): { stop: () => void } {
  void loop().catch((err) => console.error('[outbox] loop crashed:', err))
  return { stop: () => { running = false } }
}

// Run directly: tsx src/outbox/workers/emailWorker.ts
if (require.main === module) {
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  loop().catch((err) => {
    console.error('[outbox] fatal:', err)
    process.exit(1)
  })
}
