import { Worker, Job } from 'bullmq'
import { bullConnection } from '../lib/redis'
import { queueLogger } from '../lib/logger'
import type { SmsJobData } from '../lib/queues'

// ── Twilio client — only instantiated when enabled ────────────
function getTwilioClient() {
  if (process.env.TWILIO_ENABLED !== 'true') return null
  // Dynamic import to avoid errors when Twilio keys are not set
  const twilio = require('twilio')
  return twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  )
}

async function processSmsJob(job: Job<SmsJobData>): Promise<void> {
  const { to, message, bookingId } = job.data
  const log = queueLogger.child({ jobId: job.id, to })

  if (process.env.TWILIO_ENABLED !== 'true') {
    log.info('SMS disabled — skipping (set TWILIO_ENABLED=true to activate)')
    return
  }

  const client = getTwilioClient()
  await client.messages.create({
    body: message,
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
  })

  log.info({ bookingId }, 'SMS sent')
}

export function startSmsWorker() {
  const worker = new Worker<SmsJobData>('sms', processSmsJob, {
    connection: bullConnection,
    concurrency: 3,
  })

  worker.on('failed', (job, err) => {
    queueLogger.error({ jobId: job?.id, err: err.message }, 'SMS job failed')
  })

  return worker
}
