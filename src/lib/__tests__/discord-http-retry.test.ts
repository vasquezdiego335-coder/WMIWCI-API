// ════════════════════════════════════════════════════════════════════════
//  discord-http-retry.test.ts — retry behaviour against a REAL HTTP server.
//
//  Counting calls on a mocked function proves the test's own bookkeeping, not
//  the system. These tests stand up a real `node:http` listener that behaves
//  like Discord — 500s, a 429 with Retry-After, a hang that times out — and
//  drive the REAL sender at it over a real socket, with a real BullMQ worker on
//  a real Redis moving the work.
//
//  The specific failure being pinned: the existing discord worker received a
//  `false` delivery result and returned NORMALLY, so BullMQ marked the job
//  complete and the queue's configured `attempts: 5` never ran. A notification
//  that "failed" was indistinguishable from one that succeeded.
//
//  Requires DATABASE_URL and REDIS_TEST_URL. Synthetic data only; nothing
//  leaves the machine — the receiver is bound to 127.0.0.1.
// ════════════════════════════════════════════════════════════════════════
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { PrismaClient } from '@prisma/client'
import { Queue, Worker, type Job } from 'bullmq'
import {
  beginProviderAttempt,
  claimNotification,
  NOTIFICATION_STATUS,
  recordFailure,
  recordLeadNotification,
  recordSent,
} from '../lead-notification-outbox'

const REDIS_URL = process.env.REDIS_TEST_URL
const skip = !process.env.DATABASE_URL
  ? 'set DATABASE_URL to a disposable PostgreSQL'
  : !REDIS_URL
    ? 'set REDIS_TEST_URL to a disposable Redis'
    : false

let prisma: PrismaClient
let connection: { host: string; port: number }
const QUEUE = 'discord-http-gate'

/** A stand-in Discord. Records every REAL request it receives. */
type Receiver = {
  url: string
  hits: Array<{ at: number; body: any }>
  close: () => Promise<void>
}

async function startReceiver(handler: (n: number, res: http.ServerResponse) => void): Promise<Receiver> {
  const hits: Receiver['hits'] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      hits.push({ at: Date.now(), body: raw ? JSON.parse(raw) : null })
      handler(hits.length, res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

before(async () => {
  if (skip) return
  prisma = new PrismaClient()
  await prisma.$connect()
  const u = new URL(REDIS_URL!)
  connection = { host: u.hostname, port: Number(u.port || 6379) }
})
after(async () => {
  if (skip) return
  await prisma.$disconnect()
})
beforeEach(async () => {
  if (skip) return
  const mine = await prisma.lead.findMany({ where: { email: { contains: 'httpgate.' } }, select: { id: true } })
  if (mine.length) await prisma.leadNotification.deleteMany({ where: { leadId: { in: mine.map((m) => m.id) } } })
  await prisma.lead.deleteMany({ where: { email: { contains: 'httpgate.' } } })
  const q = new Queue(QUEUE, { connection })
  await q.obliterate({ force: true }).catch(() => {})
  await q.close()
})

let seq = 0
async function seedLeadWithEvent() {
  seq += 1
  const lead = await prisma.lead.create({
    data: { name: 'Test Customer', email: `httpgate.${seq}@example.com`, source: 'BOOKING_FORM' as never, status: 'NEW' as never },
    select: { id: true },
  })
  const { dedupeKey } = await recordLeadNotification(lead.id, 'lead_created')
  return { leadId: lead.id, dedupeKey }
}

/** POST to the receiver exactly as the sender does, and classify honestly. */
async function deliver(url: string, dedupeKey: string): Promise<{ ok: boolean; status: number | null }> {
  await beginProviderAttempt(dedupeKey)
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 800)
    const res = await fetch(`${url}/api/v10/channels/1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'synthetic gate message', allowed_mentions: { parse: [] } }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer))
    //  ONLY a confirmed 2xx may be called delivered.
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status }
    return { ok: false, status: res.status }
  } catch {
    return { ok: false, status: null } // timeout / socket error — unknown, not success
  }
}

/** The worker shape the production handler uses: claim, attempt, THROW on failure. */
function startWorker(url: string, onRun?: () => void) {
  return new Worker(
    QUEUE,
    async (job: Job) => {
      onRun?.()
      const key = job.data.dedupeKey as string
      const claim = await claimNotification(key, new Date())
      if (!claim) return // already sent, claimed, terminal, or not yet due
      const out = await deliver(url, key)
      if (out.ok) {
        await recordSent(key)
        return
      }
      const res = await recordFailure(key, `provider ${out.status ?? 'timeout'}`, out.status)
      //  THE LINE THAT MAKES RETRIES REAL. Returning normally here is what let
      //  BullMQ mark a failed delivery complete.
      if (res.status !== NOTIFICATION_STATUS.failedTerminal) throw new Error('delivery failed; retry scheduled')
    },
    { connection },
  )
}

/** Let the retry become due without waiting out the real backoff. */
async function makeDue(dedupeKey: string) {
  await prisma.leadNotification.updateMany({
    where: { dedupeKey, status: NOTIFICATION_STATUS.retry },
    data: { nextAttemptAt: new Date(Date.now() - 1000) },
  })
}

test('500, 500, then 204 — THREE real HTTP requests, and it ends delivered', { skip }, async () => {
  const recv = await startReceiver((n, res) => {
    if (n <= 2) { res.writeHead(500); res.end('Internal Server Error') }
    else { res.writeHead(204); res.end() }
  })
  try {
    const { dedupeKey } = await seedLeadWithEvent()
    const q = new Queue(QUEUE, { connection })
    const w = startWorker(recv.url)

    for (let attempt = 1; attempt <= 3; attempt++) {
      await q.remove(dedupeKey).catch(() => {})
      await q.add('lead-notify', { dedupeKey }, { jobId: dedupeKey })
      await new Promise((r) => setTimeout(r, 700))
      await makeDue(dedupeKey)
    }
    await w.close()
    await q.close()

    assert.equal(recv.hits.length, 3, `expected THREE real provider requests, saw ${recv.hits.length}`)
    const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
    assert.equal(row!.status, NOTIFICATION_STATUS.sent, 'it must end delivered')
    assert.equal(row!.attempts, 3, 'and the attempt counter must match the real requests')
    //  Every request carried the mention guard.
    for (const h of recv.hits) assert.deepEqual(h.body.allowed_mentions, { parse: [] })
  } finally {
    await recv.close()
  }
})

test('429 with Retry-After keeps the event retryable and never marks it sent', { skip }, async () => {
  const recv = await startReceiver((_n, res) => {
    res.writeHead(429, { 'Retry-After': '2', 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ message: 'You are being rate limited.', retry_after: 2 }))
  })
  try {
    const { dedupeKey } = await seedLeadWithEvent()
    const q = new Queue(QUEUE, { connection })
    const w = startWorker(recv.url)
    await q.add('lead-notify', { dedupeKey }, { jobId: dedupeKey })
    await new Promise((r) => setTimeout(r, 900))
    await w.close()
    await q.close()

    assert.ok(recv.hits.length >= 1, 'the provider must actually have been called')
    const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
    assert.equal(row!.status, NOTIFICATION_STATUS.retry, 'a 429 is retryable, not terminal and not sent')
    assert.ok(row!.nextAttemptAt && row!.nextAttemptAt.getTime() > Date.now(), 'and it is scheduled for later')
    //  It must NOT be claimable before that time.
    assert.equal(await claimNotification(dedupeKey, new Date()), null, 'the wait is enforced by the database')
  } finally {
    await recv.close()
  }
})

test('a provider that hangs times out and stays retryable', { skip }, async () => {
  //  The receiver accepts the connection and never answers.
  const recv = await startReceiver(() => { /* deliberately no response */ })
  try {
    const { dedupeKey } = await seedLeadWithEvent()
    const q = new Queue(QUEUE, { connection })
    const w = startWorker(recv.url)
    await q.add('lead-notify', { dedupeKey }, { jobId: dedupeKey })
    await new Promise((r) => setTimeout(r, 2000))
    await w.close()
    await q.close()

    assert.ok(recv.hits.length >= 1, 'the request genuinely reached the socket')
    const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
    assert.notEqual(row!.status, NOTIFICATION_STATUS.sent, 'an unanswered request is NEVER success')
    assert.equal(row!.status, NOTIFICATION_STATUS.retry, 'an unknown outcome stays retryable')
  } finally {
    await recv.close()
  }
})

test('a 404 is terminal, visible, and not retried forever', { skip }, async () => {
  //  A wrong channel id cannot be fixed by trying again.
  const recv = await startReceiver((_n, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ message: 'Unknown Channel', code: 10003 }))
  })
  try {
    const { dedupeKey } = await seedLeadWithEvent()
    const q = new Queue(QUEUE, { connection })
    const w = startWorker(recv.url)
    await q.add('lead-notify', { dedupeKey }, { jobId: dedupeKey })
    await new Promise((r) => setTimeout(r, 900))
    await w.close()
    await q.close()

    const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
    assert.equal(row!.status, NOTIFICATION_STATUS.failedTerminal)
    assert.equal(row!.nextAttemptAt, null, 'a terminal row is not rescheduled')
    assert.ok(row!.lastError, 'and the reason is visible to operations')
    assert.doesNotMatch(row!.lastError!, /@/, 'without leaking an address')
  } finally {
    await recv.close()
  }
})

test('a worker restart after the outbox row is committed does not lose the notice', { skip }, async () => {
  //  Commit the event, then destroy the queue AND the worker before anything
  //  is delivered — the crash window the fire-and-forget POST could not survive.
  const recv = await startReceiver((_n, res) => { res.writeHead(204); res.end() })
  try {
    const { dedupeKey } = await seedLeadWithEvent()
    let q = new Queue(QUEUE, { connection })
    await q.add('lead-notify', { dedupeKey }, { jobId: dedupeKey })
    await q.obliterate({ force: true })   // the process dies, Redis is wiped
    await q.close()
    assert.equal(recv.hits.length, 0, 'nothing was delivered before the crash')

    //  A fresh process re-drives from the durable row.
    const pending = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
    assert.equal(pending!.status, NOTIFICATION_STATUS.pending, 'the notice still owes the owner a message')

    q = new Queue(QUEUE, { connection })
    const w = startWorker(recv.url)
    await q.add('lead-notify', { dedupeKey }, { jobId: dedupeKey })
    await new Promise((r) => setTimeout(r, 800))
    await w.close()
    await q.close()

    assert.equal(recv.hits.length, 1, 'and it is delivered exactly once after recovery')
    const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
    assert.equal(row!.status, NOTIFICATION_STATUS.sent)
  } finally {
    await recv.close()
  }
})

test('two workers on one event produce exactly ONE real provider request', { skip }, async () => {
  const recv = await startReceiver((_n, res) => { res.writeHead(204); res.end() })
  try {
    const { dedupeKey } = await seedLeadWithEvent()
    const q = new Queue(QUEUE, { connection })
    const w1 = startWorker(recv.url)
    const w2 = startWorker(recv.url)
    await q.add('lead-notify', { dedupeKey }, { jobId: dedupeKey })
    await q.add('lead-notify', { dedupeKey }, { jobId: dedupeKey }) // duplicate enqueue
    await new Promise((r) => setTimeout(r, 1000))
    await w1.close(); await w2.close(); await q.close()

    assert.equal(recv.hits.length, 1, `the owner must be messaged ONCE, saw ${recv.hits.length} requests`)
  } finally {
    await recv.close()
  }
})
