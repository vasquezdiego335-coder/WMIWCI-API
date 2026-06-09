import pino from 'pino'

const isDev = process.env.NODE_ENV === 'development'

export const logger = pino({
  level: isDev ? 'debug' : 'info',
  ...(isDev
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
