// ════════════════════════════════════════════════════════════════════════
//  Combined worker host — ONE process for everything that runs off Vercel.
//  Optimized for Railway's $5 plan: a single container instead of three.
//
//    • an HTTP server (liveness + readiness + optional Stripe webhook)
//    • BullMQ workers — email / Discord cards / scheduled / marketing / webhook (no SMS: owner, 2026-09-15)
//    • event-driven transactional-outbox drains + an aligned recovery sweep
//    • self-healing registration of the recurring schedules
//    • the Discord gateway bot — slash commands + interaction acks
//
//  Run:  npm run host:start   (Railway start command)
//
//  THIS FILE IS DELIBERATELY THIN (2026-09-15). It used to import every worker,
//  the bot, Prisma and Stripe statically, so a module that threw at import
//  (redis.ts refusing a missing REDIS_URL was one) killed the process before the
//  HTTP server existed: no /health, no banner, a crash loop and a stack trace.
//  Now it imports only the host, which starts the HTTP server first, validates
//  the configuration, and only then loads the workers. The sequence, the
//  endpoints and the exit policy are documented in src/worker-runtime/host.ts.
//
//  Endpoints: GET /livez (process up), GET /readyz (= /healthz, /health, /):
//  config + Redis PING + Postgres + every worker attached + every schedule
//  registered. POST /api/stripe/webhook is a supported fallback; the
//  recommended topology keeps the Stripe endpoint on the API.
//
//  Note on Discord: the BullMQ discord worker posts cards over REST
//  (discord-rest, no login); the bot started by the host is the ONLY gateway
//  login in this process, and it happens only after the workers have started.
// ════════════════════════════════════════════════════════════════════════
import 'dotenv/config'

import { logger } from './lib/logger'
import { startWorkerHost } from './worker-runtime/host'

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

const host = startWorkerHost()

process.on('SIGINT', () => void host.shutdown('SIGINT'))
process.on('SIGTERM', () => void host.shutdown('SIGTERM'))
