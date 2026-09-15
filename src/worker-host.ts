// ════════════════════════════════════════════════════════════════════════
//  Combined worker host — ONE process for everything that runs off Vercel.
//  Optimized for Railway's $5 plan: a single container instead of three.
//
//    • an HTTP server (health checks + optional Stripe webhook)
//    • BullMQ workers — email / Discord cards / scheduled / marketing / webhook (no SMS: owner, 2026-09-15)
//    • event-driven transactional-outbox drains + an aligned recovery sweep
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

import { timingSafeEqual } from 'node:crypto'
import express, { type Request, type Response } from 'express'

import { startEmailWorker } from './workers/email.worker'
import { startDiscordWorker } from './workers/discord.worker'
import { startScheduledWorker } from './workers/scheduled.worker'
import { startMarketingWorker } from './workers/marketing.worker'
import { startWebhookWorker } from './workers/webhook.worker'
import { getDiscordClient } from './bot/discord-actions'
import { processStripeWebhook } from './lib/stripe-events'
import { logger } from './lib/logger'
import { checkEnv } from './lib/env'
import { prisma } from './lib/db'
import type { Worker } from 'bullmq'
import { pingAppRedis } from './lib/redis-health'
import { evaluateWorkerHealth, CONFIG_FAILURE_EXIT_DEFAULT_MS } from './lib/worker-health'
import { blockRecordFailureStats, numberFromEnv } from './lib/email-guard'

// ── Liveness state surfaced by the health endpoints ─────────────────────
const state = {
  startedAt: new Date().toISOString(),
  bullWorkers: 0,
  outbox: false,
  /// Names of required env vars that are missing. Non-empty ⇒ NO worker starts.
  envMissing: [] as string[],
  /// Set when a configuration failure has scheduled the process to exit.
  exitAt: null as string | null,
}

/** The running BullMQ workers, kept so health can ask each whether it is attached. */
let runningWorkers: Worker[] = []
/** How many queue workers this host starts (email, discord, scheduled, marketing, webhook). */
const EXPECTED_WORKERS = 5
let discordClient: { isReady(): boolean } | null = null

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
  // "ok" requires REAL observations, not configuration presence: no missing
  // config, Redis answering a PING, and every queue worker running. It never
  // queries Postgres, so polling it cannot keep Neon awake. No secret values,
  // only booleans, names, counts and the deployed commit.
  const health = async (_req: Request, res: Response): Promise<void> => {
    const workers = runningWorkers.map((w) => ({ name: w.name, running: w.isRunning(), paused: w.isPaused() }))
    const redis = runningWorkers.length > 0 || state.envMissing.length === 0 ? await pingAppRedis() : null
    const verdict = evaluateWorkerHealth({ envMissing: state.envMissing, redis, workers, expectedWorkers: EXPECTED_WORKERS })
    res.status(verdict.ok ? 200 : 503).json({
      status: verdict.ok ? 'ok' : 'degraded',
      service: 'worker-host',
      problems: verdict.problems,
      uptimeSeconds: Math.round(process.uptime()),
      ...state,
      redis,
      workers,
      discordBot: { configured: Boolean(process.env.DISCORD_BOT_TOKEN?.trim()), ready: discordClient?.isReady() ?? false },
      commit: (process.env.RAILWAY_GIT_COMMIT_SHA ?? '').slice(0, 12) || null,
      flags: {
        outboxEnabled: process.env.OUTBOX_ENABLED === 'true',
        outboxDryRun: process.env.OUTBOX_EMAIL_DRYRUN === 'true',
        emailSendingEnabled: process.env.EMAIL_SENDING_ENABLED !== 'false',
        // Discovery runs on THIS service; the admin page reads the API's copy.
        marketingAgentEnabled: process.env.EMAIL_MARKETING_AGENT_ENABLED === 'true',
      },
      emailBlockRecordFailures: blockRecordFailureStats(),
      now: new Date().toISOString(),
    })
  }
  const healthRoute = (req: Request, res: Response): void => {
    health(req, res).catch((err) =>
      res.status(503).json({ status: 'degraded', service: 'worker-host', problems: [`health check failed: ${err instanceof Error ? err.message : String(err)}`] })
    )
  }
  app.get('/', healthRoute)
  app.get('/health', healthRoute)
  app.get('/healthz', healthRoute) // point Railway's Healthcheck Path here

  // ── Email diagnostics ─────────────────────────────────────────────
  // The Next.js app exposes GET /api/email/health, but THIS process is a plain
  // Express host and does not serve Next routes — so that endpoint 404s here.
  // That mattered the moment it was needed: the worker SIGNS unsubscribe links
  // and the API VERIFIES them, so if their EMAIL_TOKEN_SECRET differs, every
  // link is dead and nothing surfaces it. Comparing the two required shell
  // access; now it is a curl against each host.
  //
  // Same auth and same redaction as the Next route: presence, length, and a
  // SHA-256 fingerprint PREFIX. No secret value is ever returned.
  app.get('/api/email/health', async (req: Request, res: Response) => {
    const expected = process.env.EMAIL_SUPPRESSION_API_KEY?.trim()
    if (!expected) {
      res.status(503).json({ ok: false, error: 'diagnostics_disabled' })
      return
    }
    const given = String(req.header('x-suppression-key') ?? req.query.key ?? '').trim()
    const a = Buffer.from(given)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({ ok: false, error: 'unauthorized' })
      return
    }
    try {
      const { runDiagnostics } = await import('./lib/email-diagnostics')
      const d = await runDiagnostics()
      res.status(d.status === 'blocked' ? 503 : 200).json({ service: 'worker-host', ...d })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

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

  // 1b) ENVIRONMENT VALIDATION (audit E-01).
  //
  // THIS IS THE ENTRYPOINT PRODUCTION ACTUALLY RUNS (`host:start` →
  // worker-host.ts). src/workers/index.ts is the local-dev entrypoint; putting
  // the check only there would have left production exactly as unprotected as
  // before, which is the failure mode this whole release is about.
  //
  // It does NOT throw, deliberately. This file already established that a hard
  // crash on missing config is the wrong shape for Railway — a crash-loop hides
  // the reason and the operator sees only a restarting service. So the failure
  // is made loud a better way: the banner goes to logs, /health turns 503 and
  // NAMES the missing variables, and NO WORKER STARTS — nothing is processed
  // with a broken configuration.
  const env = checkEnv()
  if (!env.ok) {
    state.envMissing = env.missingRequired
    // FAIL VISIBLY, THEN FAIL (2026-09-15). This used to return and leave a live
    // process that processed nothing: Railway saw a running container, its
    // ON_FAILURE restart policy never fired, and no health check was configured
    // to notice — a worker that silently did nothing forever. It now serves 503
    // (naming the missing variables) for a grace window so the reason is
    // readable, then exits non-zero so the deployment shows as crashed and the
    // restart policy and Railway's crash notification both fire. The banner is
    // re-printed on every restart, so the reason is never hidden.
    const graceMs = numberFromEnv(process.env.WORKER_CONFIG_FAILURE_EXIT_MS, CONFIG_FAILURE_EXIT_DEFAULT_MS)
    state.exitAt = new Date(Date.now() + graceMs).toISOString()
    logger.error(
      { missing: env.missingRequired, exitAt: state.exitAt },
      `STARTUP HALTED — missing required environment variables: ${env.missingRequired.join(', ')}. ` +
        'No queue worker has been started, so nothing will be processed with this configuration. ' +
        `/health returns 503 and lists them; the process exits at ${state.exitAt} so the deployment is marked crashed.`
    )
    setTimeout(() => {
      logger.error({ missing: env.missingRequired }, 'exiting: required configuration is still missing')
      process.exit(1)
    }, graceMs)
    return
  }
  logger.info('  ✓ environment validated')

  // 2) Redis is required for the BullMQ queues. In production redis.ts already
  //    refuses to load without REDIS_URL; outside production this is the guard.
  if (!process.env.REDIS_URL) {
    state.envMissing = ['REDIS_URL']
    logger.error('REDIS_URL is not set — the BullMQ workers cannot run. /health reports it; set REDIS_URL and redeploy.')
    return
  }

  // 3) BullMQ workers (return Worker instances so we can close them on shutdown)
  const bullWorkers = [
    startEmailWorker(),
    startDiscordWorker(),
    startScheduledWorker(),
    startMarketingWorker(),
    startWebhookWorker(), // consumes 'webhook-retry' — processes Stripe events
  ]
  state.bullWorkers = bullWorkers.length
  runningWorkers = bullWorkers

  // 4) Transactional email outbox. There is deliberately NO Postgres timer
  //    here: real events nudge the scheduled queue immediately and its aligned
  //    recovery cron catches lost nudges. The old three-second poll was enough
  //    to keep Neon's compute bill running around the clock while idle.
  state.outbox = process.env.OUTBOX_ENABLED === 'true'

  // 5) Discord gateway bot (slash commands). Idempotent singleton; logs + skips
  //    cleanly if DISCORD_BOT_TOKEN is missing/placeholder.
  discordClient = getDiscordClient()

  logger.info(
    `✓ Combined worker host running — HTTP server + ${bullWorkers.length} BullMQ workers (incl. webhook) + ` +
      `${state.outbox ? 'event-driven outbox' : 'outbox disabled'} + Discord bot`
  )

  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Shutting down worker host…')
    await Promise.all(bullWorkers.map((w) => w.close())).catch(() => undefined)
    await prisma.$disconnect().catch(() => undefined)
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
