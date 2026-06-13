import 'dotenv/config'
import { fetchPendingJobs, markJobSent, markJobFailed, reapStaleProcessingJobs } from '../db/emailJobsRepo'
import { EmailJob, EventType } from '../domain/events'
import {
  sendPreApprovalEmail,
  sendFinalConfirmationEmail,
  sendRescheduleRequestEmail,
  sendDatePickedEmail,
} from '../services/emailService'

// ════════════════════════════════════════════════════════════════════════
//  Outbox worker — polls email_jobs and sends. Safe to run as many instances
//  as you like: fetchPendingJobs claims rows with FOR UPDATE SKIP LOCKED, so no
//  two workers ever process the same row. Run: tsx src/outbox/workers/emailWorker.ts
// ════════════════════════════════════════════════════════════════════════

const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_MS ?? 3000)
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
async function routeAndSend(job: EmailJob): Promise<void> {
  switch (job.eventType) {
    case EventType.PAYMENT_COMPLETED:
      await sendPreApprovalEmail(job.payload as any)
      return
    case EventType.APPROVED:
      await sendFinalConfirmationEmail(job.payload as any)
      return
    case EventType.RESCHEDULE_REQUESTED:
      await sendRescheduleRequestEmail(job.payload as any)
      return
    case EventType.NEW_DATE_PICKED:
      if (SEND_DATE_PICKED_EMAIL) await sendDatePickedEmail(job.payload as any)
      return // otherwise a no-op success: the approval card already went out
    default:
      throw new Error(`Unknown event type: ${job.eventType}`)
  }
}

/** One poll cycle: claim due jobs and process each. Returns how many it claimed. */
export async function processOnce(): Promise<number> {
  const jobs = await fetchPendingJobs(BATCH)
  for (const job of jobs) {
    try {
      await routeAndSend(job)
      await markJobSent(job.id)
      console.log(`[outbox] sent ${job.eventType} job=${job.id} booking=${job.bookingId}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await markJobFailed(job, msg)
      console.error(
        `[outbox] FAILED ${job.eventType} job=${job.id} attempt=${job.attempts}/${job.maxAttempts}: ${msg}`
      )
    }
  }
  return jobs.length
}

/** Requeue stale 'processing' jobs, throttled to REAP_INTERVAL_MS. */
async function maybeReap(): Promise<void> {
  if (Date.now() - lastReapAt < REAP_INTERVAL_MS) return
  lastReapAt = Date.now()
  try {
    const reaped = await reapStaleProcessingJobs(STALE_PROCESSING_MS)
    if (reaped > 0) console.warn(`[outbox] reaped ${reaped} stale 'processing' job(s) → requeued`)
  } catch (err) {
    console.error('[outbox] reaper error:', err)
  }
}

async function loop(): Promise<void> {
  console.log(
    `[outbox] worker started (poll=${POLL_INTERVAL_MS}ms batch=${BATCH} staleReap=${STALE_PROCESSING_MS}ms)`
  )
  await maybeReap() // reap once at startup before claiming anything
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
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// Run directly: tsx src/outbox/workers/emailWorker.ts
if (require.main === module) {
  loop().catch((err) => {
    console.error('[outbox] fatal:', err)
    process.exit(1)
  })
}
