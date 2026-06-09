import { Worker, Job } from 'bullmq'
import { bullConnection } from '../lib/redis'
import { queueLogger } from '../lib/logger'
import type { MarketingJobData } from '../lib/queues'
import { enrollCustomer, type MarketingContact } from '../lib/marketing'

async function processMarketingJob(job: Job<MarketingJobData>): Promise<void> {
  const { type, bookingId, payload } = job.data
  const log = queueLogger.child({ jobId: job.id, type, bookingId })

  switch (type) {
    case 'enroll-customer':
      await enrollCustomer(payload as unknown as MarketingContact)
      log.info('Marketing enrollment processed')
      break
    default:
      log.warn({ type }, 'Unknown marketing job type')
  }
}

export function startMarketingWorker() {
  const worker = new Worker<MarketingJobData>('marketing', processMarketingJob, {
    connection: bullConnection,
    concurrency: 2,
  })

  worker.on('failed', (job, err) => {
    queueLogger.error({ jobId: job?.id, err: err.message }, 'Marketing job failed')
  })

  return worker
}
