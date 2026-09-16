// ════════════════════════════════════════════════════════════════════════
//  Combined worker host — startup sequence, health server, shutdown
//  ---------------------------------------------------------------------
//  src/worker-host.ts is the thin entrypoint Railway runs; this is the host.
//
//  STARTUP ORDER (2026-09-15). Every step can only fail AFTER the one before it
//  has made the failure visible:
//    1. HTTP server — /livez answers the moment the port binds. Nothing this
//       module imports statically can throw (redis.ts builds no connection at
//       import; the worker, bot, Prisma and Stripe modules are loaded later).
//    2. Configuration — missing variables are listed by NAME on /readyz, no
//       worker starts, and the process exits non-zero after a grace window so
//       the deployment shows as crashed. The ONLY non-zero exit this host makes.
//    3. Modules — loaded with literal dynamic imports (./load-modules).
//    4. BullMQ workers — each one counted as attached only after its Redis
//       connection emits 'ready' (bullmq sets isRunning() before connecting).
//       The scheduled worker starts the self-healing cron reconciler.
//    5. Discord gateway bot — LAST, so it never logs in for a host whose
//       configuration was rejected or whose workers never started.
//
//  READINESS (/readyz, and /healthz, /health, / as aliases) is 200 only when the
//  configuration is complete, Redis answers PING, Postgres answers SELECT 1
//  (cached), every queue worker is running and attached, and every recurring
//  schedule is registered. Problems are listed by name; no value is returned.
//  A cron or Redis problem makes readiness 503 and NEVER exits the process:
//  Railway restarts at most ten times, and a long outage would otherwise leave
//  transactional email permanently down.
// ════════════════════════════════════════════════════════════════════════

import { timingSafeEqual } from 'node:crypto'
import type { Server } from 'node:http'
import express, { type Request, type Response } from 'express'
import type { Worker } from 'bullmq'

import { logger } from '../lib/logger'
import { checkEnv } from '../lib/env'
import { redisConfigProblem } from '../lib/redis'
import { pingAppRedis, sanitizeRedisError, type RedisPingResult } from '../lib/redis-health'
import {
  CONFIG_FAILURE_EXIT_DEFAULT_MS,
  SCHEDULE_BOOT_GRACE_MS,
  createErrorLogLimiter,
  evaluateWorkerHealth,
  singleFlightCache,
} from '../lib/worker-health'
import type { WorkerModules, WorkerQueueName } from './load-modules'

/** How many queue workers this host starts (email, discord, scheduled, marketing, webhook-retry). */
export const EXPECTED_WORKERS = 5

export type HostPhase = 'booting' | 'config_failed' | 'loading' | 'load_failed' | 'starting' | 'running' | 'stopping'

export type WorkerConfigReport = { ok: boolean; missing: string[]; invalid: string[] }

/** Names and reasons only — never a value. */
export function validateWorkerConfig(): WorkerConfigReport {
  const env = checkEnv()
  const invalid: string[] = []
  const redisProblem = redisConfigProblem()
  if (redisProblem && !env.missingRequired.includes('REDIS_URL')) invalid.push(redisProblem)
  return { ok: env.ok && invalid.length === 0, missing: env.missingRequired, invalid }
}

/**
 * Blank or unparseable means the default (a Railway row with no value must not
 * become 0). Deliberately NOT email-guard's numberFromEnv: importing that module
 * constructs Prisma and Resend, which is exactly what this file must not do
 * before the HTTP server is serving.
 */
function msFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw.trim())
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export type WorkerHostDeps = {
  port: number
  hostname: string
  validateConfig: () => WorkerConfigReport
  loadModules: () => Promise<WorkerModules>
  pingRedis: () => Promise<RedisPingResult>
  exit: (code: number) => void
  configFailureExitMs: number
  now: () => number
  dbCacheMs: number
  dbTimeoutMs: number
  closeTimeoutMs: number
}

export type ReadinessReport = { httpStatus: 200 | 503; body: Record<string, unknown> }

export type WorkerHostHandle = {
  /** Resolves with the bound port, or null when binding failed. */
  listening: Promise<number | null>
  /** Resolves when the startup sequence has finished (or halted). Never rejects. */
  booted: Promise<void>
  phase(): HostPhase
  readiness(): Promise<ReadinessReport>
  /** Graceful: stop cron loop, close workers (active jobs finish), disconnect, exit(code). */
  shutdown(reason: string, code?: number): Promise<void>
}

type Attachment = { name: WorkerQueueName; worker: Worker | null; attachedAt: string | null; lastError: string | null }

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const errMessage = (err: unknown) => sanitizeRedisError(err instanceof Error ? err.message : String(err))

export function startWorkerHost(overrides: Partial<WorkerHostDeps> = {}): WorkerHostHandle {
  const d: WorkerHostDeps = {
    port: Number(process.env.PORT ?? 8080),
    hostname: '0.0.0.0',
    validateConfig: validateWorkerConfig,
    // Literal specifier: keeps the worker modules in the env-ownership graph.
    loadModules: async () => (await import('./load-modules')).loadWorkerModules(),
    pingRedis: () => pingAppRedis(),
    exit: (code) => process.exit(code),
    configFailureExitMs: msFromEnv(process.env.WORKER_CONFIG_FAILURE_EXIT_MS, CONFIG_FAILURE_EXIT_DEFAULT_MS),
    now: Date.now,
    dbCacheMs: 10_000,
    dbTimeoutMs: 3_000,
    closeTimeoutMs: 25_000,
    ...overrides,
  }

  // ── State surfaced by the health endpoints ──────────────────────────
  const bootMs = d.now()
  const state = {
    startedAt: new Date(bootMs).toISOString(),
    phase: 'booting' as HostPhase,
    bullWorkers: 0,
    outbox: false,
    /// Names of required env vars that are missing. Non-empty ⇒ NO worker starts.
    envMissing: [] as string[],
    /// Present-but-unusable configuration (name + reason, never the value).
    configInvalid: [] as string[],
    /// Set when a fatal startup failure has scheduled the process to exit.
    exitAt: null as string | null,
    /// Sanitized reason a module failed to load.
    fatal: null as string | null,
  }
  const attachments: Attachment[] = []
  let mods: WorkerModules | null = null
  let discordClient: { isReady(): boolean } | null = null
  let exitTimer: ReturnType<typeof setTimeout> | null = null
  let httpServer: Server | null = null
  const errorLog = createErrorLogLimiter()

  const setPhase = (phase: HostPhase) => {
    state.phase = phase
    logger.info({ event: 'worker.startup.phase', phase }, `worker host phase: ${phase}`)
  }

  // Postgres observation for readiness: bounded, and cached so a polled
  // endpoint issues at most one SELECT 1 per window.
  let dbObservation: (() => Promise<{ ok: boolean; error: string | null; checkedAt: string }>) | null = null
  const observeDb = () => {
    if (!mods) return Promise.resolve(null)
    if (!dbObservation) {
      const m = mods
      dbObservation = singleFlightCache(async () => {
        try {
          await withTimeout(m.probeDb(), d.dbTimeoutMs, 'SELECT 1')
          return { ok: true, error: null, checkedAt: new Date(d.now()).toISOString() }
        } catch (err) {
          return { ok: false, error: errMessage(err), checkedAt: new Date(d.now()).toISOString() }
        }
      }, d.dbCacheMs, d.now)
    }
    return dbObservation()
  }

  async function readiness(): Promise<ReadinessReport> {
    const workers = attachments.map((a) => {
      const w = a.worker
      return {
        name: a.name,
        running: w ? w.isRunning() : false,
        paused: w ? w.isPaused() : false,
        attached: a.attachedAt !== null,
        attachedAt: a.attachedAt,
        lastError: a.lastError,
      }
    })
    // An unusable REDIS_URL is already named under configuration; do not build a
    // probe client from it.
    const redisUnusable = state.configInvalid.some((p) => p.startsWith('REDIS_URL'))
    const redis = redisUnusable ? null : await d.pingRedis()
    const db = await observeDb()
    const schedules = mods ? mods.getCronStatus() : null
    const verdict = evaluateWorkerHealth({
      phase: state.phase,
      envMissing: state.envMissing,
      configInvalid: state.configInvalid,
      redis,
      db,
      workers,
      expectedWorkers: EXPECTED_WORKERS,
      schedules: mods ? { status: schedules, bootGraceElapsed: d.now() - bootMs >= SCHEDULE_BOOT_GRACE_MS } : null,
    })
    return {
      httpStatus: verdict.ok ? 200 : 503,
      body: {
        status: verdict.ok ? 'ok' : 'degraded',
        service: 'worker-host',
        problems: verdict.problems,
        uptimeSeconds: Math.round(process.uptime()),
        ...state,
        redis,
        db,
        workers,
        schedules,
        discordBot: { configured: Boolean(process.env.DISCORD_BOT_TOKEN?.trim()), ready: discordClient?.isReady() ?? false },
        commit: (process.env.RAILWAY_GIT_COMMIT_SHA ?? '').slice(0, 12) || null,
        flags: {
          outboxEnabled: process.env.OUTBOX_ENABLED === 'true',
          outboxDryRun: process.env.OUTBOX_EMAIL_DRYRUN === 'true',
          emailSendingEnabled: process.env.EMAIL_SENDING_ENABLED !== 'false',
          // Discovery runs on THIS service; the admin page reads the API's copy.
          marketingAgentEnabled: process.env.EMAIL_MARKETING_AGENT_ENABLED === 'true',
        },
        emailBlockRecordFailures: mods ? mods.blockRecordFailureStats() : null,
        now: new Date(d.now()).toISOString(),
      },
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  HTTP server
  // ════════════════════════════════════════════════════════════════════
  const app = express()
  app.disable('x-powered-by')

  // Liveness: the process is up and serving. No I/O, never 503 — a restart
  // cannot fix Redis, Postgres or a missing variable.
  app.get('/livez', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'alive',
      service: 'worker-host',
      phase: state.phase,
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: state.startedAt,
      exitAt: state.exitAt,
      commit: (process.env.RAILWAY_GIT_COMMIT_SHA ?? '').slice(0, 12) || null,
    })
  })

  const readyRoute = (_req: Request, res: Response): void => {
    readiness()
      .then((r) => res.status(r.httpStatus).json(r.body))
      .catch((err) =>
        res.status(503).json({ status: 'degraded', service: 'worker-host', problems: [`health check failed: ${errMessage(err)}`] })
      )
  }
  app.get('/readyz', readyRoute)
  app.get('/healthz', readyRoute) // readiness (point a Railway Healthcheck Path here only knowingly: it is 503 until workers attach)
  app.get('/health', readyRoute)
  app.get('/', readyRoute)

  // ── Email diagnostics ─────────────────────────────────────────────
  // The Next.js app exposes GET /api/email/health, but THIS process is a plain
  // Express host and does not serve Next routes. The worker SIGNS unsubscribe
  // links and the API VERIFIES them, so their EMAIL_TOKEN_SECRET must match;
  // this lets an operator compare the two with a curl against each host.
  // Same auth and redaction as the Next route: presence, length, and a SHA-256
  // fingerprint PREFIX. No secret value is ever returned.
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
      const { runDiagnostics } = await import('../lib/email-diagnostics')
      const diag = await runDiagnostics()
      res.status(diag.status === 'blocked' ? 503 : 200).json({ service: 'worker-host', ...diag })
    } catch (err) {
      res.status(500).json({ ok: false, error: errMessage(err) })
    }
  })

  // ── Stripe webhook (OPTIONAL — only if you register THIS host in Stripe) ──
  // RECOMMENDED TOPOLOGY keeps the Stripe endpoint on the API, which verifies +
  // enqueues; this host processes the jobs. This route reuses the exact same
  // verified core (src/lib/stripe-events.ts), so the two can never drift.
  // RAW body is mandatory: Stripe's signature is computed over the exact bytes.
  app.post('/api/stripe/webhook', express.raw({ type: '*/*' }), async (req: Request, res: Response): Promise<void> => {
    if (!mods || state.phase !== 'running') {
      // Never 2xx before the event can be processed: 503 makes Stripe retry.
      res.status(503).json({ error: 'starting' })
      return
    }
    try {
      const result = await mods.processStripeWebhook(req.body as Buffer, req.header('stripe-signature'))
      res.status(result.status).json(result.body)
    } catch (err) {
      // Should never happen (processStripeWebhook is total), but if it does,
      // 200 keeps Stripe from hammering retries on OUR bug — we log + own it.
      logger.error({ err: errMessage(err) }, 'stripe webhook handler crashed unexpectedly')
      res.status(200).json({ ok: true })
    }
  })

  // 404 for anything else (keeps noise out of the logs, returns fast).
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' })
  })

  const listening = new Promise<number | null>((resolve) => {
    const server = app.listen(d.port, d.hostname, () => {
      const addr = server.address()
      const port = addr && typeof addr === 'object' ? addr.port : d.port
      // ⚠️ This exact line is how you confirm the worker is serving HTTP.
      logger.info({ port }, `✓ HTTP server listening on port ${port}`)
      resolve(port)
    })
    httpServer = server
    server.on('error', (err) => {
      // Workers still start: an unreachable health endpoint must not also stop
      // customer email. The log line is the only evidence, so it is explicit.
      logger.error(
        { event: 'worker.http_bind_failed', port: d.port, err: errMessage(err) },
        'HTTP server failed to bind — health checks and the worker webhook are unavailable'
      )
      resolve(null)
    })
  })

  // ════════════════════════════════════════════════════════════════════
  //  Fatal startup failure: serve 503 for a grace window, then exit(1)
  // ════════════════════════════════════════════════════════════════════
  function scheduleFatalExit(reason: string): void {
    const graceMs = d.configFailureExitMs
    state.exitAt = new Date(d.now() + graceMs).toISOString()
    exitTimer = setTimeout(() => {
      logger.error({ reason, missing: state.envMissing, invalid: state.configInvalid, fatal: state.fatal }, `exiting: ${reason}`)
      void shutdown(reason, 1)
    }, graceMs)
  }

  async function boot(): Promise<void> {
    // 1) HTTP first — Railway sees a live port immediately.
    await listening

    // 2) ENVIRONMENT VALIDATION (audit E-01).
    // FAIL VISIBLY, THEN FAIL (2026-09-15). A host that returned here used to
    // stay a live process that processed nothing: Railway saw a running
    // container and its ON_FAILURE restart policy never fired. It now serves 503
    // (naming the missing variables) for a grace window so the reason is
    // readable, then exits non-zero so the deployment shows as crashed and
    // Railway's crash notification fires. The banner is re-printed on every
    // restart, so the reason is never hidden.
    const config = d.validateConfig()
    state.envMissing = config.missing
    state.configInvalid = config.invalid
    if (!config.ok) {
      setPhase('config_failed')
      scheduleFatalExit('required configuration is still missing or invalid')
      const named = [
        ...(config.missing.length ? [`missing required environment variables: ${config.missing.join(', ')}`] : []),
        ...(config.invalid.length ? [`invalid configuration: ${config.invalid.join('; ')}`] : []),
      ].join('; ')
      logger.error(
        { event: 'worker.config.invalid', missing: config.missing, invalid: config.invalid, exitAt: state.exitAt },
        `STARTUP HALTED — ${named}. ` +
          'No queue worker has been started, so nothing will be processed with this configuration. ' +
          `/readyz returns 503 and lists them; the process exits at ${state.exitAt} so the deployment is marked crashed.`
      )
      return
    }
    logger.info('  ✓ environment validated')

    // 3) Modules that construct clients — only now.
    setPhase('loading')
    try {
      mods = await d.loadModules()
    } catch (err) {
      setPhase('load_failed')
      state.fatal = errMessage(err)
      scheduleFatalExit('a worker module failed to load')
      logger.error(
        { event: 'worker.module_load_failed', err: state.fatal, stack: err instanceof Error ? err.stack?.split('\n').slice(1, 8).join('\n') : undefined, exitAt: state.exitAt },
        `STARTUP HALTED — a worker module failed to load: ${state.fatal}. /readyz returns 503; the process exits at ${state.exitAt}.`
      )
      return
    }

    // 4) BullMQ workers. One failing constructor never stops the others.
    setPhase('starting')
    for (const starter of mods.starters) {
      const a: Attachment = { name: starter.name, worker: null, attachedAt: null, lastError: null }
      attachments.push(a)
      try {
        const w = starter.start()
        a.worker = w
        // Attached = its blocking connection became ready. Emitted via setTimeout
        // after a network connect, so a listener added here cannot miss it.
        w.on('ready', () => {
          if (a.attachedAt) return
          a.attachedAt = new Date(d.now()).toISOString()
          logger.info({ event: 'worker.attached', queue: a.name }, `queue worker "${a.name}" connected`)
        })
        // Also stops an EventEmitter 'error' from becoming process-fatal.
        // Rate-limited: a Redis outage emits one per reconnect attempt.
        w.on('error', (err) => {
          const message = errMessage(err)
          a.lastError = message
          const decision = errorLog(`${a.name} | ${message}`)
          if (decision.log) {
            logger.error({ event: 'worker.error', queue: a.name, err: message, suppressedSinceLastLog: decision.suppressed }, `queue worker "${a.name}" error`)
          }
        })
      } catch (err) {
        a.lastError = errMessage(err)
        logger.error({ event: 'worker.start_failed', queue: a.name, err: a.lastError }, `queue worker "${a.name}" failed to start`)
      }
    }
    state.bullWorkers = attachments.filter((a) => a.worker).length

    // Transactional email outbox. There is deliberately NO Postgres timer here:
    // real events nudge the scheduled queue immediately and its aligned recovery
    // cron catches lost nudges. The old three-second poll was enough to keep
    // Neon's compute bill running around the clock while idle.
    state.outbox = process.env.OUTBOX_ENABLED === 'true'
    setPhase('running')

    // 5) Discord gateway bot (slash commands), only after everything above.
    //    Idempotent singleton; logs + skips cleanly if DISCORD_BOT_TOKEN is
    //    missing/placeholder.
    try {
      discordClient = mods.getDiscordClient()
    } catch (err) {
      logger.error({ err: errMessage(err) }, 'Discord gateway bot failed to start (queue workers are unaffected)')
    }

    logger.info(
      `✓ Combined worker host running — HTTP server + ${state.bullWorkers} BullMQ workers (incl. webhook) + ` +
        `${state.outbox ? 'event-driven outbox' : 'outbox disabled'} + Discord bot`
    )
  }

  let stopping: Promise<void> | null = null
  function shutdown(reason: string, code = 0): Promise<void> {
    if (stopping) return stopping
    stopping = (async () => {
      setPhase('stopping')
      if (exitTimer) clearTimeout(exitTimer)
      logger.info({ signal: reason }, 'Shutting down worker host…')
      try {
        mods?.stopCronJobs()
      } catch {
        /* never block shutdown */
      }
      // close() waits for active jobs, so an in-flight send finishes and is
      // recorded instead of re-running as a stalled job. Bounded.
      const workers = attachments.map((a) => a.worker).filter((w): w is Worker => w !== null)
      await withTimeout(Promise.allSettled(workers.map((w) => w.close())), d.closeTimeoutMs, 'closing queue workers').catch((err) =>
        logger.warn({ err: errMessage(err) }, 'queue workers did not close in time')
      )
      if (mods) await withTimeout(mods.disconnectDb(), 5_000, 'prisma disconnect').catch(() => undefined)
      if (httpServer) {
        const server = httpServer
        await withTimeout(
          new Promise<void>((resolve) => {
            server.close(() => resolve())
            server.closeAllConnections?.()
          }),
          2_000,
          'closing HTTP server'
        ).catch(() => undefined)
      }
      logger.info('Worker host stopped')
      d.exit(code)
    })()
    return stopping
  }

  const booted = boot().catch((err) => {
    // Nothing in boot() is expected to throw; if it does, make it visible and
    // fatal through the same graceful path.
    state.fatal = errMessage(err)
    logger.error({ err: state.fatal }, 'Worker host startup failed')
    if (state.phase !== 'stopping') scheduleFatalExit('worker host startup failed')
  })

  return { listening, booted, phase: () => state.phase, readiness, shutdown }
}
