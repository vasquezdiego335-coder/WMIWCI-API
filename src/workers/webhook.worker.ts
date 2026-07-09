import { Worker, Job } from 'bullmq'
import type Stripe from 'stripe'
import { bullConnection } from '../lib/redis'
import { queueLogger } from '../lib/logger'
import { processStripeEventJob } from '../lib/stripe-events'

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

  worker.on('failed', (job, err) => {
    queueLogger.error(
      { jobId: job?.id, eventId: job?.data?.event?.id, err: err.message },
      'Stripe webhook job failed'
    )
  })

  return worker
}
