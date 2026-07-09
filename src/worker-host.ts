// ════════════════════════════════════════════════════════════════════════
//  Combined worker host — ONE process for everything that runs off Vercel.
//  Optimized for Railway's $5 plan: a single container instead of three.
//
//    • an HTTP server (health checks + optional Stripe webhook)
//    • 5 BullMQ workers — email / Discord cards / SMS / scheduled / marketing
//    • the transactional-outbox email poller
//    • the Discord gateway bot — slash commands + interaction acks
//
//  WHY THE HTTP SERVER EXISTS
//  ──────────────────────────
//  A pure BullMQ worker opens NO TCP port, so Railway's generated domain
//  returns "Application failed to respond" and there's no way to confirm the
//  worker is alive except by reading logs. We add a tiny Express server that:
//    • listens on process.env.PORT (Railway injects it),
//    • answers GET / and GET /healthz  → Railway health check + your own curl,
//    • answers POST /api/stripe/webhook → ONLY needed if you point the Stripe
//      Dashboard endpoint at the WORKER instead of the API. It reuses the exact
//      same verified core (src/lib/stripe-events.ts) as the Next.js API route,
//      so the two can never drift.
//
//  RECOMMENDED TOPOLOGY: keep the Stripe endpoint on the API
//  (…/api/stripe/webhook on the API service). The API verifies + enqueues; this
//  worker processes the jobs. The webhook route below is a supported fallback,
//  not the default. Either way, the health endpoints fix the "failed to
//  respond" page and let Railway know the container is alive.
//
//  An HTTP server and BullMQ workers coexist trivially in one Node process:
//  both are just async event-loop consumers. Neither blocks the other.
//
//  Run:  npm run host:start   (Railway start command)
//
//  Note on Discord: the BullMQ discord worker posts cards over REST
//  (discord-rest, no login); the bot below is the ONLY gateway login in this
//  process — exactly one, which is correct.
// ════════════════════════════════════════════════════════════════════════
import 'dotenv/config'

import express, { type Request, type Response } from 'express'

import { startEmailWorker } from './workers/email.worker'
import { startDiscordWorker } from './workers/discord.worker'
import { startSmsWorker } from './workers/sms.worker'
import { startScheduledWorker } from './workers/scheduled.worker'
import { startMarketingWorker } from './workers/marketing.worker'
import { startWebhookWorker } from './workers/webhook.worker'
import { startOutboxWorker } from './outbox/workers/emailWorker'
import { getDiscordClient } from './bot/discord-actions'
import { processStripeWebhook } from './lib/stripe-events'
import { logger } from './lib/logger'

// ── Liveness state surfaced by the health endpoints ─────────────────────
const state = {
  startedAt: new Date().toISOString(),
  redis: false,
  bullWorkers: 0,
  outbox: false,
  discordBot: false,
}

// ── Never let a stray rejection/exception kill the whole host ───────────
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

// ════════════════════════════════════════════════════════════════════════
//  HTTP server — starts FIRST so Railway's domain responds and the health
//  check passes even while the workers spin up (or if Redis is misconfigured).
// ════════════════════════════════════════════════════════════════════════
function startHttpServer(): void {
  const app = express()
  const port = Number(process.env.PORT ?? 8080)

  app.disable('x-powered-by')

  // ── Health endpoints ──────────────────────────────────────────────
  // status is "ok" only when Redis is connected AND the workers registered.
  const health = (_req: Request, res: Response): void => {
    const ok = state.redis && state.bullWorkers > 0
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      service: 'worker-host',
      uptimeSeconds: Math.round(process.uptime()),
      ...state,
      now: new Date().toISOString(),
    })
  }
  app.get('/', health)
  app.get('/health', health)
  app.get('/healthz', health) // point Railway's Healthcheck Path here

  // ── Stripe webhook (OPTIONAL — only if you register THIS host in Stripe) ──
  // RAW body is mandatory: Stripe's signature is computed over the exact bytes.
  // express.raw() hands us the untouched Buffer; JSON parsing would break the
  // signature. type:'*/*' guarantees we capture the body even if Stripe ever
  // changes the content-type, since this route is Stripe-only.
  app.post(
    '/api/stripe/webhook',
    express.raw({ type: '*/*' }),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const result = await processStripeWebhook(
          req.body as Buffer,
          req.header('stripe-signature')
        )
        res.status(result.status).json(result.body)
      } catch (err) {
        // Should never happen (processStripeWebhook is total), but if it does,
        // 200 keeps Stripe from hammering retries on OUR bug — we log + own it.
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'stripe webhook handler crashed unexpectedly'
        )
        res.status(200).json({ ok: true })
      }
    }
  )

  // 404 for anything else (keeps noise out of the logs, returns fast).
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' })
  })

  const server = app.listen(port, '0.0.0.0', () => {
    // ⚠️ This exact line is how you confirm the worker is serving HTTP.
    logger.info({ port }, `✓ HTTP server listening on port ${port}`)
  })

  server.on('error', (err) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'HTTP server failed to bind — health checks and the worker webhook are unavailable'
    )
  })
}

async function main(): Promise<void> {
  // 1) HTTP first — Railway sees a live port immediately.
  startHttpServer()

  // 2) Redis is required for the BullMQ queues. If it's missing we DON'T crash:
  //    the HTTP server stays up (health reports "degraded") so you can see the
  //    misconfig in the browser/logs, fix REDIS_URL in Railway, and redeploy.
  if (!process.env.REDIS_URL) {
    logger.error(
      'REDIS_URL is not set — the BullMQ workers cannot run. HTTP/health stays up so you can see this; set REDIS_URL in Railway and redeploy.'
    )
    return
  }
  state.redis = true

  // 3) BullMQ workers (return Worker instances so we can close them on shutdown)
  const bullWorkers = [
    startEmailWorker(),
    startDiscordWorker(),
    startSmsWorker(),
    startScheduledWorker(),
    startMarketingWorker(),
    startWebhookWorker(), // consumes 'webhook-retry' — processes Stripe events
  ]
  state.bullWorkers = bullWorkers.length

  // 4) Transactional-outbox email poller (Postgres only)
  const outbox = startOutboxWorker()
  state.outbox = true

  // 5) Discord gateway bot (slash commands). Idempotent singleton; logs + skips
  //    cleanly if DISCORD_BOT_TOKEN is missing/placeholder.
  getDiscordClient()
  state.discordBot = true

  logger.info(
    '✓ Combined worker host running — HTTP server + 6 BullMQ workers (incl. webhook) + outbox poller + Discord bot'
  )

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
  logger.error(
    { err: err instanceof Error ? err.message : String(err) },
    'Worker host startup failed'
  )
  process.exit(1)
})
