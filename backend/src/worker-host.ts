// ════════════════════════════════════════════════════════════════════════
//  Combined worker host — ONE process for everything that runs off Vercel.
//  Optimized for Railway's $5 plan: a single container instead of three.
//
//    • 5 BullMQ workers — email / Discord cards / SMS / scheduled / marketing
//    • the transactional-outbox email poller
//    • the Discord gateway bot — slash commands + interaction acks
//
//  The Next.js API stays on Vercel; it is never imported or run here.
//  Run:  npm run host:start   (Railway start command)
//
//  Note on Discord: the BullMQ discord worker posts cards over REST
//  (discord-rest, no login); the bot below is the ONLY gateway login in this
//  process — exactly one, which is correct.
// ════════════════════════════════════════════════════════════════════════
import 'dotenv/config'

import { startEmailWorker } from './workers/email.worker'
import { startDiscordWorker } from './workers/discord.worker'
import { startSmsWorker } from './workers/sms.worker'
import { startScheduledWorker } from './workers/scheduled.worker'
import { startMarketingWorker } from './workers/marketing.worker'
import { startOutboxWorker } from './outbox/workers/emailWorker'
import { getDiscordClient } from './bot/discord-actions'
import { logger } from './lib/logger'

process.on('unhandledRejection', (reason) =>
  logger.error(
    {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    },
    'unhandledRejection in worker host'
  )
)
process.on('uncaughtException', (err) =>
  logger.error({ err: err.message, stack: err.stack }, 'uncaughtException in worker host')
)

async function main(): Promise<void> {
  if (!process.env.REDIS_URL) {
    logger.error('REDIS_URL is not set — the BullMQ workers cannot run. Exiting.')
    process.exit(1)
  }

  // 1) BullMQ workers (return Worker instances so we can close them on shutdown)
  const bullWorkers = [
    startEmailWorker(),
    startDiscordWorker(),
    startSmsWorker(),
    startScheduledWorker(),
    startMarketingWorker(),
  ]

  // 2) Transactional-outbox email poller (Postgres only)
  const outbox = startOutboxWorker()

  // 3) Discord gateway bot (slash commands). Idempotent singleton; logs + skips
  //    cleanly if DISCORD_BOT_TOKEN is missing/placeholder.
  getDiscordClient()

  logger.info('✓ Combined worker host running — 5 BullMQ workers + outbox poller + Discord bot')

  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Shutting down worker host…')
    outbox.stop()
    await Promise.all(bullWorkers.map((w) => w.close())).catch(() => undefined)
    logger.info('Worker host stopped')
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Worker host startup failed')
  process.exit(1)
})
