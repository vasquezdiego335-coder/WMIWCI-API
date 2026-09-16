// ════════════════════════════════════════════════════════════════════════
//  Worker host — everything that can fail at import, loaded AFTER the HTTP
//  server is serving and the configuration has been validated.
//  ---------------------------------------------------------------------
//  These modules construct Prisma, Resend, Stripe and the Discord client, and
//  reach src/lib/redis.ts. When they were static imports of worker-host.ts, any
//  throw among them killed the process before a single health endpoint existed,
//  so the only evidence was a stack trace in a log nobody was reading.
//
//  LITERAL import() specifiers only: the env-ownership scanner
//  (src/lib/env-ownership-scan.ts) follows `import('…')` literals to build the
//  worker's import graph; a computed specifier would silently shrink it.
// ════════════════════════════════════════════════════════════════════════

import type { Worker } from 'bullmq'
import type { CronStatus } from '../lib/cron-schedules'

export type WorkerQueueName = 'email' | 'discord' | 'scheduled' | 'marketing' | 'webhook-retry'

export type WorkerModules = {
  /** In start order. Each start() constructs one BullMQ Worker. */
  starters: { name: WorkerQueueName; start: () => Worker }[]
  getCronStatus: () => CronStatus | null
  stopCronJobs: () => void
  getDiscordClient: () => { isReady(): boolean }
  processStripeWebhook: (body: Buffer, signature: string | undefined) => Promise<{ status: number; body: unknown }>
  /** SELECT 1 through the application's Prisma client. Rejects on failure. */
  probeDb: () => Promise<void>
  disconnectDb: () => Promise<void>
  blockRecordFailureStats: () => unknown
}

export async function loadWorkerModules(): Promise<WorkerModules> {
  const emailWorker = await import('../workers/email.worker')
  const discordWorker = await import('../workers/discord.worker')
  const scheduledWorker = await import('../workers/scheduled.worker')
  const marketingWorker = await import('../workers/marketing.worker')
  const webhookWorker = await import('../workers/webhook.worker')
  const bot = await import('../bot/discord-actions')
  const stripeEvents = await import('../lib/stripe-events')
  const db = await import('../lib/db')
  const emailGuard = await import('../lib/email-guard')

  return {
    starters: [
      { name: 'email', start: emailWorker.startEmailWorker },
      { name: 'discord', start: discordWorker.startDiscordWorker },
      { name: 'scheduled', start: scheduledWorker.startScheduledWorker },
      { name: 'marketing', start: marketingWorker.startMarketingWorker },
      // consumes 'webhook-retry' — processes Stripe events
      { name: 'webhook-retry', start: webhookWorker.startWebhookWorker },
    ],
    getCronStatus: scheduledWorker.getCronStatus,
    stopCronJobs: scheduledWorker.stopCronJobs,
    getDiscordClient: bot.getDiscordClient,
    processStripeWebhook: (body, signature) => stripeEvents.processStripeWebhook(body, signature),
    probeDb: async () => {
      await db.prisma.$queryRaw`SELECT 1`
    },
    disconnectDb: () => db.prisma.$disconnect(),
    blockRecordFailureStats: emailGuard.blockRecordFailureStats,
  }
}
