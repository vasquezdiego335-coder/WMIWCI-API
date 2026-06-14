/**
 * Standalone Bull Board UI server.
 * Runs alongside the workers process to provide a visual queue inspector.
 *
 * Start it with: npx tsx src/workers/bull-board.ts
 * Or it's started automatically alongside workers when BULL_BOARD_ENABLED=true.
 *
 * Access at http://localhost:3001/bull-board (internal network only).
 * Protect with a reverse proxy + basic auth in production.
 */

import express from 'express'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { ExpressAdapter } from '@bull-board/express'
import { Queue } from 'bullmq'
import { bullConnection } from '@/lib/redis'

const QUEUE_NAMES = ['email', 'sms', 'discord', 'webhook-retry', 'scheduled']
const PORT = parseInt(process.env.BULL_BOARD_PORT ?? '3001', 10)

async function startBullBoard() {
  const serverAdapter = new ExpressAdapter()
  serverAdapter.setBasePath('/bull-board')

  const queues = QUEUE_NAMES.map((name) => new Queue(name, { connection: bullConnection }))

  createBullBoard({
    // Cast bridges a cross-package type skew between @bull-board/api's
    // BullMQAdapter and createBullBoard's BaseAdapter[] — runtime is correct.
    queues: queues.map((q) => new BullMQAdapter(q)) as any,
    serverAdapter,
  })

  const app = express()
  app.use('/bull-board', serverAdapter.getRouter())

  // Health endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', queues: QUEUE_NAMES.length })
  })

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`🐂 Bull Board running at http://localhost:${PORT}/bull-board`)
  })
}

startBullBoard().catch(console.error)
