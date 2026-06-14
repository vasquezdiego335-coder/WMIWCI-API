import pino from 'pino'

const isDev = process.env.NODE_ENV === 'development'
// Inside the Next.js server (webpack-bundled), pino's pino-pretty *transport*
// runs in a worker thread (thread-stream) whose entry resolves to a chunk Next
// never emits → "Cannot find .next/server/vendor-chunks/lib/worker.js" → the
// worker exits → every log call throws uncaughtException and kills the dev
// server. NEXT_RUNTIME is set ONLY inside Next; the standalone worker/bot (tsx)
// processes leave it unset, so they keep colorized pretty logs.
const insideNext = !!process.env.NEXT_RUNTIME

export const logger = pino({
  level: isDev ? 'debug' : 'info',
  ...(isDev && !insideNext
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        },
      }
    : {}),
  base: {
    service: 'moveit-app',
    env: process.env.NODE_ENV,
  },
})

// Child loggers for each subsystem
export const apiLogger = logger.child({ module: 'api' })
export const webhookLogger = logger.child({ module: 'webhook' })
export const queueLogger = logger.child({ module: 'queue' })
export const botLogger = logger.child({ module: 'discord-bot' })
export const authLogger = logger.child({ module: 'auth' })
