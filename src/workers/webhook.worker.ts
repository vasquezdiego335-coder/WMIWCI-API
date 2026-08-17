import { Worker, Job } from 'bullmq'
import type Stripe from 'stripe'
import { bullConnection } from '../lib/redis'
import { queueLogger } from '../lib/logger'
import { isWebhookLeaseHeld, processStripeEventJob } from '../lib/stripe-events'

// ════════════════════════════════════════════════════════════════════════
//  Stripe webhook worker — consumes the `webhook-retry` queue.
//  The webhook HTTP handler verifies the signature and enqueues the event
//  here, then returns 200 immediately. This worker does the heavy lifting
//  (idempotency log + fulfillment + fan-out to email/sms/discord queues).
//  BullMQ retries per the queue's attempts policy (5) on failure.
// ════════════════════════════════════════════════════════════════════════

export type WebhookJobData = { event: Stripe.Event }

async function processWebhookJob(job: Job<WebhookJobData>): Promise<void> {
  const { event } = job.data
  const log = queueLogger.child({ jobId: job.id, eventId: event?.id, eventType: event?.type })

  if (!event || !event.id) {
    log.warn('webhook job with no event payload — dropping')
    return
  }

  log.info('Processing Stripe webhook event')
  await processStripeEventJob(event)
  log.info('Stripe webhook event processed')
}

export function startWebhookWorker() {
  const worker = new Worker<WebhookJobData>('webhook-retry', processWebhookJob, {
    connection: bullConnection,
    concurrency: 5,
  })

  // ── ITEM R3 — a failure here is the RETRY, not the loss ────────────────
  // Two shapes are worth telling apart in the log, because they call for
  // opposite reactions:
  //   • lease held  — another runner owns the event right now. Expected
  //     contention; the retry exists precisely to come back for it. The job
  //     MUST still fail so BullMQ re-delivers — returning normally is what
  //     turned a killed run into a silently completed job.
  //   • last attempt — the queue will not come back again. That is the moment
  //     the event becomes invisible, so it is logged as such rather than as one
  //     more identical line among five.
  worker.on('failed', (job, err) => {
    const attempts = job?.opts?.attempts ?? 1
    const made = job?.attemptsMade ?? 0
    const isFinalAttempt = made >= attempts
    const base = {
      jobId: job?.id,
      eventId: job?.data?.event?.id,
      eventType: job?.data?.event?.type,
      attempt: made,
      attempts,
      err: err.message,
    }
    if (isFinalAttempt) {
      queueLogger.error(
        base,
        'Stripe webhook job failed on its LAST attempt — the queue will not retry it again. ' +
          'The webhook_logs row for this event is left "failed"; replay the event from the Stripe dashboard.'
      )
      return
    }
    if (isWebhookLeaseHeld(err)) {
      queueLogger.warn(base, 'Stripe webhook job deferred — another runner holds the lease; this delivery will be retried')
      return
    }
    queueLogger.error(base, 'Stripe webhook job failed')
  })

  return worker
}
