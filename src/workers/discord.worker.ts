import { Worker, Job } from 'bullmq'
import { bullConnection } from '../lib/redis'
import { queueLogger } from '../lib/logger'
import type { DiscordJobData } from '../lib/queues'
import {
  postBookingApprovalCard,
  postDiscountApprovalCard,
  postPaymentAlert,
  postFailureAlert,
  createJobChannels,
  postDailySchedule,
  postContactMessage,
} from '../bot/discord-actions'

async function processDiscordJob(job: Job<DiscordJobData>): Promise<void> {
  const { type, bookingId, payload } = job.data
  const log = queueLogger.child({ jobId: job.id, type, bookingId })

  log.info('Processing discord job')

  switch (type) {
    case 'booking-created':
      await postBookingApprovalCard(bookingId!, payload)
      break
    case 'payment-received':
      await postPaymentAlert(bookingId!, payload)
      break
    case 'discount-request':
      await postDiscountApprovalCard(bookingId!, payload)
      break
    case 'create-job-channels':
      await createJobChannels(bookingId!, payload)
      break
    case 'failure-alert':
      await postFailureAlert(payload)
      break
    case 'daily-schedule':
      await postDailySchedule(payload)
      break
    case 'contact-message':
      await postContactMessage(payload)
      break
    case 'reschedule-offer':
      // Re-post a fresh approval card after a customer picks a new date.
      await postBookingApprovalCard(bookingId!, payload)
      break
    default:
      log.warn({ type }, 'Unknown discord job type')
  }

  log.info('Discord job completed')
}

export function startDiscordWorker() {
  const worker = new Worker<DiscordJobData>('discord', processDiscordJob, {
    connection: bullConnection,
    concurrency: 2, // Discord rate limits — keep low
  })

  worker.on('failed', (job, err) => {
    queueLogger.error({ jobId: job?.id, err: err.message }, 'Discord job failed')
  })

  return worker
}
