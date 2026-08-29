import { Worker, Job } from 'bullmq'
import { bullConnection } from '../lib/redis'
import { queueLogger } from '../lib/logger'
import type { DiscordJobData } from '../lib/queues'
import {
  postBookingApprovalCard,
  postPaymentAlert,
  postFailureAlert,
  createJobChannels,
  postDailySchedule,
  postContactMessage,
  postLeadCard,
} from '../bot/discord-rest'
//  STATIC, like every other handler here. These were dynamic `await import()`
//  calls inside the job branch, which is the one thing this file did
//  differently from its other cases - and the lead-notify job hung the whole
//  worker process in production, taking email, SMS and Discord cards down
//  with it. A module graph resolved at start-up cannot stall a job handler.
import { processLeadNotification } from '../lib/lead-notification-processor'
import { deliverLeadNotice } from '../lib/lead-notification-transport'
import { discordQueue } from '../lib/queues'

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
      // Door-hanger campaign retired 2026-07-21. A job left in Redis from
      // before the cutover is acknowledged and dropped rather than posting a
      // 30%-off card that no longer has a rule behind it.
      log.warn('discount-request job ignored — door-hanger campaign retired')
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
    // ── DURABLE LEAD NOTICE (V3) ────────────────────────────────────────
    //  The claim is atomic, the attempt counter moves only when a provider
    //  request actually begins, and a failure RE-THROWS so this queue's
    //  configured attempts are genuinely reachable. The pre-existing
    //  'lead-created' case below logs a failure and returns normally, which is
    //  exactly why its attempts: 5 never fired.
    case 'lead-notify': {
      //  DELEGATES to the SAME function the integration tests drive. Nothing
      //  about this job's behaviour lives in the worker file any more, so a
      //  test cannot pass against a clone while production does something else.
      //  SHAPE, and why it is asserted rather than defaulted.
      //
      //  This read is `job.data.payload.dedupeKey`, matching every other case in
      //  this file. The publishers used to put `dedupeKey` at the TOP level of
      //  job.data, so `payload` was undefined, `dedupeKey` came out '', and the
      //  `if (!dedupeKey) return` below completed the job in milliseconds having
      //  done nothing at all. No error, no retry, no delivery — the owner simply
      //  was not told about the lead.
      //
      //  A missing key now THROWS. A malformed job must fail loudly and land in
      //  BullMQ's failed set where it can be seen; returning quietly is what made
      //  this invisible for two deploys.
      const dedupeKey = String((payload as { dedupeKey?: string })?.dedupeKey ?? '')
      if (!dedupeKey) {
        throw new Error(
          'lead-notify job has no payload.dedupeKey — the publisher and this handler disagree ' +
            'about the job shape. Expected { type, payload: { dedupeKey } }.',
        )
      }
      await processLeadNotification(dedupeKey, deliverLeadNotice, {
        //  A job that arrived before its due time is put BACK on the queue with
        //  the remaining delay rather than being silently dropped.
        reschedule: async (dueAt) => {
          const delay = Math.max(0, dueAt.getTime() - Date.now())
          await discordQueue.remove(dedupeKey).catch(() => {})
          await discordQueue.add(
            'lead-notify',
            { type: 'lead-notify', payload: { dedupeKey } },
            { jobId: dedupeKey, delay },
          )
        },
      })
      return
    }

    case 'lead-created': {
      // postLeadCard returns FALSE when no channel was configured or the REST
      // post failed. restSendToChannel never throws, so without observing the
      // return value a dropped card looked exactly like a delivered one.
      const delivered = await postLeadCard(payload)
      const leadId = typeof payload.leadId === 'string' ? payload.leadId : null
      if (leadId) {
        const { recordLeadAlertOutcome } = await import('../lib/quote-capture')
        await recordLeadAlertOutcome(leadId, delivered)
      }
      if (!delivered) log.warn({ leadId }, 'lead card was not delivered')
      break
    }
    case 'reschedule-offer':
      // Re-post a fresh approval card after a customer picks a new date.
      await postBookingApprovalCard(bookingId!, payload)
      break
    case 'deposit-paid': {
      // Confirmed deposit-link payment. The money is ALREADY recorded — this
      // job only tells the owner. Throwing hands the retry to BullMQ (5
      // attempts, exponential backoff); the exactly-once claim inside
      // deliverDepositNotification means a retry can never double-post.
      const depositRequestId = typeof payload.depositRequestId === 'string' ? payload.depositRequestId : null
      if (!depositRequestId) {
        log.error('deposit-paid job without depositRequestId — dropping')
        break
      }
      const { deliverDepositNotification } = await import('../lib/discord-payments')
      const outcome = await deliverDepositNotification(depositRequestId)
      if (!outcome.delivered && !outcome.skipped) {
        // A real delivery failure (not "already sent"). Surface it so the queue
        // retries; the row is already marked FAILED for the admin list.
        throw new Error(`deposit notification failed: ${outcome.error ?? 'unknown'}`)
      }
      if (outcome.skipped) log.info({ depositRequestId, skipped: outcome.skipped }, 'deposit notification skipped')
      break
    }
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
