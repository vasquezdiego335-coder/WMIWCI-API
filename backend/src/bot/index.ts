import 'dotenv/config'
import { getDiscordClient } from './discord-actions'
import { botLogger } from '../lib/logger'

// ════════════════════════════════════════════════════════════════════════
//  Discord bot entrypoint.
//  Run with:  npm run bot:dev   (tsx --watch src/bot/index.ts)
//  Booting the client registers the gateway interaction handlers and prints
//  the startup banner once the bot is ready.
// ════════════════════════════════════════════════════════════════════════

botLogger.info('Starting Discord bot process…')

// Surface anything that would otherwise crash the process silently.
process.on('unhandledRejection', (reason) =>
  botLogger.error({ reason: reason instanceof Error ? reason.message : String(reason) }, 'unhandledRejection')
)
process.on('uncaughtException', (err) =>
  botLogger.error({ err: err.message, stack: err.stack }, 'uncaughtException')
)

getDiscordClient()
