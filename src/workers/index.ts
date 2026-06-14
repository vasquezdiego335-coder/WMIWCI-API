// ════════════════════════════════════════════════════════════════════════
//  Worker entrypoint — run with: npm run workers:dev
//
//  ⚠️  CRITICAL: `import 'dotenv/config'` MUST be the very first import.
//  Every other import eventually reaches src/lib/redis.ts, which reads
//  process.env.REDIS_URL at module-load time. If dotenv hasn't populated
//  the env yet, REDIS_URL is undefined → ioredis falls back to
//  redis://localhost:6379 → ECONNREFUSED on machines without local Redis.
// ════════════════════════════════════════════════════════════════════════
import 'dotenv/config'

import { startEmailWorker } from './email.worker'
import { startDiscordWorker } from './discord.worker'
import { startSmsWorker } from './sms.worker'
import { startScheduledWorker } from './scheduled.worker'
import { startMarketingWorker } from './marketing.worker'
import { logger } from '../lib/logger'

// ── Startup diagnostics ──────────────────────────────────────────────────
function printWorkerBanner(): void {
  const redisUrl = process.env.REDIS_URL ?? '(NOT SET — will use localhost:6379!)'
  // Mask the password so it never shows up in logs/screenshots.
  const safeRedis = redisUrl.replace(/:([^@]+)@/, ':****@')

  const vars: Record<string, string> = {
    NODE_ENV: process.env.NODE_ENV ?? 'undefined',
    REDIS_URL: safeRedis,
    DATABASE_URL: process.env.DATABASE_URL ? '✓ set' : '✗ NOT SET',
    RESEND_API_KEY: process.env.RESEND_API_KEY && !process.env.RESEND_API_KEY.includes('REPLACE') ? '✓ set' : '✗ NOT SET',
    TWILIO_ENABLED: process.env.TWILIO_ENABLED ?? 'false',
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN && !process.env.DISCORD_BOT_TOKEN.includes('REPLACE') ? '✓ set' : '✗ NOT SET',
    DISCORD_CHANNEL_SCHEDULING: process.env.DISCORD_CHANNEL_SCHEDULING && !process.env.DISCORD_CHANNEL_SCHEDULING.includes('REPLACE') ? '✓ set' : '✗ NOT SET',
    DISCORD_CHANNEL_JOBS: process.env.DISCORD_CHANNEL_JOBS && !process.env.DISCORD_CHANNEL_JOBS.includes('REPLACE') ? '✓ set' : '✗ NOT SET',
  }

  const lines = Object.entries(vars).map(([k, v]) => `  ${k.padEnd(30)} ${v}`)

  console.log([
    '',
    '╔══════════════════════════════════════════════════════════════╗',
    '║   WE MOVE IT. WE CLEAR IT. — WORKERS STARTING              ║',
    '╠══════════════════════════════════════════════════════════════╣',
    ...lines.map((l) => `║ ${l}`),
    '╚══════════════════════════════════════════════════════════════╝',
    '',
  ].join('\n'))

  // Hard-fail if REDIS_URL is missing — don't silently connect to localhost.
  if (!process.env.REDIS_URL) {
    logger.error(
      'REDIS_URL is not set. Workers cannot start without a Redis connection. ' +
        'Add REDIS_URL to backend/.env (or .env.local). Exiting.'
    )
    process.exit(1)
  }
}

async function main() {
  printWorkerBanner()
  logger.info('Starting BullMQ workers…')

  const emailWorker = startEmailWorker()
  logger.info('  ✓ email worker started')

  const discordWorker = startDiscordWorker()
  logger.info('  ✓ discord worker started')

  const smsWorker = startSmsWorker()
  logger.info('  ✓ sms worker started')

  const scheduledWorker = startScheduledWorker()
  logger.info('  ✓ scheduled worker started')

  const marketingWorker = startMarketingWorker()
  logger.info('  ✓ marketing worker started')

  logger.info('All 5 workers running — waiting for jobs')

  // Graceful shutdown
  async function shutdown() {
    logger.info('Shutting down workers…')
    await Promise.all([
      emailWorker.close(),
      discordWorker.close(),
      smsWorker.close(),
      scheduledWorker.close(),
      marketingWorker.close(),
    ])
    logger.info('All workers stopped cleanly')
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// Surface anything that would otherwise crash the process silently.
// Log the STACK, not just the message — the stack names the exact file/library
// frame, which is the only reliable way to tell which worker/connection threw.
process.on('unhandledRejection', (reason) =>
  logger.error(
    {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    },
    'unhandledRejection in worker process'
  )
)
process.on('uncaughtException', (err) =>
  logger.error({ err: err.message, stack: err.stack }, 'uncaughtException in worker process')
)

main().catch((err) => {
  logger.error(err, 'Worker startup failed')
  process.exit(1)
})
