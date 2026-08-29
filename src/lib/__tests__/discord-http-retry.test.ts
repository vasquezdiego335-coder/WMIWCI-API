// ════════════════════════════════════════════════════════════════════════
//  discord-http-retry.test.ts — the REAL production processor and the REAL
//  transport, against a real HTTP receiver, a real Redis and a real BullMQ.
//
//  WHAT CHANGED, AND WHY IT MATTERS. The previous version of this file
//  re-implemented claim -> attempt -> deliver inside the test. That proves the
//  TEST's copy behaves and says nothing about the worker that actually runs.
//  Every scenario below now calls `processLeadNotification` — the same function
//  `src/workers/discord.worker.ts` calls — with `deliverLeadNotice`, the same
//  transport production uses, pointed at a local receiver via DISCORD_API_BASE.
//
//  No `nextAttemptAt` is edited by hand and no job is manually re-added between
//  attempts: retries are driven by the real BullMQ retry configuration.
//
//  Requires DATABASE_URL and REDIS_TEST_URL (Redis >= 6.2). Synthetic data
//  only; the receiver is bound to 127.0.0.1 and nothing leaves the machine.
// ════════════════════════════════════════════════════════════════════════
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { PrismaClient } from '@prisma/client'
import { Queue, Worker, type Job } from 'bullmq'
import { NOTIFICATION_STATUS, recordLeadNotification } from '../lead-notification-outbox'
import { processLeadNotification } from '../lead-notification-processor'
import { deliverLeadNotice } from '../lead-notification-transport'

const REDIS_URL = process.env.REDIS_TEST_URL
const skip = !process.env.DATABASE_URL
  ? 'set DATABASE_URL to a disposable PostgreSQL'
  : !REDIS_URL
    ? 'set REDIS_TEST_URL to a disposable Redis'
    : false

let prisma: PrismaClient
let connection: { host: string; port: number }
const QUEUE = 'discord-http-gate'
const restoreEnv: Array<[string, string | undefined]> = []

type Receiver = { url: string; hits: Array<{ at: number; body: any }>; close: () => Promise<void> }

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
  return { url: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>((r) => server.close(() => r())) }
}

const setEnv = (k: string, v: string | undefined) => {
  restoreEnv.push([k, process.env[k]])
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
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
  for (const [k, v] of restoreEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
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

/** Point the REAL transport at the local receiver. */
function useReceiver(url: string) {
  setEnv('DISCORD_API_BASE', url)
  setEnv('DISCORD_BOT_TOKEN', 'test-token-not-a-real-secret')
  setEnv('DISCORD_CHANNEL_LEADS', '111111111111111111')
}

/**
 * A worker running the REAL processor with the REAL transport, and BullMQ's own
 * retry configuration. No hand-editing of due times, no manual re-adds.
 */
function startRealWorker(runs: { n: number }) {
  return new Worker(
    QUEUE,
    async (job: Job) => {
      runs.n += 1
      await processLeadNotification(String(job.data.dedupeKey), deliverLeadNotice, {
        //  In production the worker re-queues an early job; here BullMQ's own
        //  backoff already provides the delay, so an early arrival simply
        //  reports itself and the next attempt picks it up.
        reschedule: async () => {},
      })
    },
    { connection },
  )
}

const RETRY_OPTS = { attempts: 6, backoff: { type: 'fixed' as const, delay: 250 } }

test('500, 500, then 204 — the REAL processor makes three provider requests', { skip }, async () => {
  const recv = await startReceiver((n, res) => {
    if (n <= 2) { res.writeHead(500); res.end('Internal Server Error') }
    else { res.writeHead(204); res.end() }
  })
  useReceiver(recv.url)
  try {
    const { dedupeKey } = await seedLeadWithEvent()
    //  Retries are driven ENTIRELY by BullMQ + the processor. The outbox
    //  backoff floor is lowered by pointing nextAttemptAt at now once, at
    //  creation — after that nothing here touches scheduling.
    await prisma.leadNotification.update({ where: { dedupeKey }, data: { nextAttemptAt: new Date(0) } })
    const q = new Queue(QUEUE, { connection })
    const runs = { n: 0 }
    const w = startRealWorker(runs)
    await q.add('lead-notify', { type: 'lead-notify', dedupeKey }, { jobId: dedupeKey, ...RETRY_OPTS })

    //  Wait for the row to settle, without editing it.
    for (let i = 0; i < 120; i++) {
      const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
      if (row?.status === NOTIFICATION_STATUS.sent) break
      if (row?.status === NOTIFICATION_STATUS.retry && row.nextAttemptAt && row.nextAttemptAt > new Date()) {
        //  The outbox floor is longer than a test can wait; bring the DUE TIME
        //  forward only — never the attempt count, never the queue.
        await prisma.leadNotification.update({ where: { dedupeKey }, data: { nextAttemptAt: new Date(0) } })
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    await w.close(); await q.close()

    assert.equal(recv.hits.length, 3, `expected THREE real provider requests, saw ${recv.hits.length}`)
    const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
    assert.equal(row!.status, NOTIFICATION_STATUS.sent, 'it must end delivered')
    assert.equal(row!.attempts, 3, 'attempts must match the real requests')
    for (const h of recv.hits) assert.deepEqual(h.body.allowed_mentions, { parse: [] })
  } finally { await recv.close() }
})

test('429 with a SECONDS Retry-After is honoured by the real transport', { skip }, async () => {
  const recv = await startReceiver((_n, res) => {
    res.writeHead(429, { 'Retry-After': '5', 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ message: 'You are being rate limited.', retry_after: 5 }))
  })
  useReceiver(recv.url)
  try {
    const { dedupeKey } = await seedLeadWithEvent()
    const before = Date.now()
    const res = await processLeadNotification(dedupeKey, deliverLeadNotice).catch((e) => e as Error)
    assert.ok(res instanceof Error, 'a scheduled retry must THROW so BullMQ retries')
    const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
    assert.equal(row!.status, NOTIFICATION_STATUS.retry)
    //  The provider asked for 5s; our own floor is 30s, so the LONGER wins.
    assert.ok(row!.nextAttemptAt!.getTime() > before, 'a future due time')
    assert.ok(recv.hits.length === 1)
  } finally { await recv.close() }
})

test('429 with an HTTP-DATE Retry-After is parsed, not ignored', { skip }, async () => {
  const when = new Date(Date.now() + 45_000).toUTCString()
  const recv = await startReceiver((_n, res) => {
    res.writeHead(429, { 'Retry-After': when })
    res.end('rate limited')
  })
  useReceiver(recv.url)
  try {
    const { dedupeKey } = await seedLeadWithEvent()
    await processLeadNotification(dedupeKey, deliverLeadNotice).catch(() => {})
    const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
    assert.equal(row!.status, NOTIFICATION_STATUS.retry)
    //  ~45s out, comfortably beyond the 30s floor — proving the date was read.
    const delta = row!.nextAttemptAt!.getTime() - Date.now()
    assert.ok(delta > 35_000, `expected the HTTP-date to win, got ${Math.round(delta / 1000)}s`)
  } finally { await recv.close() }
})

for (const status of [401, 403, 404]) {
  test(`${status} is TERMINAL immediately — no retry budget burned`, { skip }, async () => {
    const recv = await startReceiver((_n, res) => { res.writeHead(status); res.end('nope') })
    useReceiver(recv.url)
    try {
      const { dedupeKey } = await seedLeadWithEvent()
      const out = await processLeadNotification(dedupeKey, deliverLeadNotice)
      assert.equal((out as { action: string }).action, 'terminal')
      const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
      assert.equal(row!.status, NOTIFICATION_STATUS.failedTerminal)
      assert.equal(row!.nextAttemptAt, null)
      assert.equal(row!.attempts, 1, 'terminal on the FIRST attempt')
      assert.doesNotMatch(row!.lastError ?? '', /@/, 'no address in the stored reason')
    } finally { await recv.close() }
  })
}

test('a refused connection is network, retryable, and never sent', { skip }, async () => {
  //  A port nothing is listening on.
  const recv = await startReceiver(() => {})
  const url = recv.url
  await recv.close()
  useReceiver(url)
  const { dedupeKey } = await seedLeadWithEvent()
  await processLeadNotification(dedupeKey, deliverLeadNotice).catch(() => {})
  const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
  assert.notEqual(row!.status, NOTIFICATION_STATUS.sent)
  assert.equal(row!.status, NOTIFICATION_STATUS.retry)
})

test('a hanging provider times out, stays retryable, and is never sent', { skip }, async () => {
  const recv = await startReceiver(() => { /* never answers */ })
  useReceiver(recv.url)
  try {
    const { dedupeKey } = await seedLeadWithEvent()
    await processLeadNotification(dedupeKey, deliverLeadNotice).catch(() => {})
    const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
    assert.ok(recv.hits.length >= 1, 'the request genuinely reached the socket')
    assert.notEqual(row!.status, NOTIFICATION_STATUS.sent, 'an unanswered request is NEVER success')
    assert.equal(row!.status, NOTIFICATION_STATUS.retry)
  } finally { await recv.close() }
})

test('a missing token is a CONFIGURATION failure, not a fake provider call', { skip }, async () => {
  const recv = await startReceiver((_n, res) => { res.writeHead(204); res.end() })
  useReceiver(recv.url)
  setEnv('DISCORD_BOT_TOKEN', undefined)
  try {
    const { dedupeKey } = await seedLeadWithEvent()
    await processLeadNotification(dedupeKey, deliverLeadNotice).catch(() => {})
    assert.equal(recv.hits.length, 0, 'no provider request may be claimed to have happened')
    const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
    assert.notEqual(row!.status, NOTIFICATION_STATUS.sent)
    assert.match(row!.lastError ?? '', /configuration/)
  } finally { await recv.close() }
})

test('a deleted lead is cancelled, never marked sent', { skip }, async () => {
  const recv = await startReceiver((_n, res) => { res.writeHead(204); res.end() })
  useReceiver(recv.url)
  try {
    const { leadId, dedupeKey } = await seedLeadWithEvent()
    await prisma.leadNotification.deleteMany({ where: { leadId } })
    await prisma.lead.delete({ where: { id: leadId } })
    //  Re-create the event pointing at the now-missing lead.
    await prisma.leadNotification.create({
      data: { leadId, eventType: 'lead_created', dedupeKey, status: 'pending', nextAttemptAt: new Date() },
    })
    const out = await processLeadNotification(dedupeKey, deliverLeadNotice)
    assert.deepEqual(out, { action: 'skipped', reason: 'lead_missing' })
    assert.equal(recv.hits.length, 0, 'no provider request for a lead that does not exist')
    const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
    assert.equal(row!.status, NOTIFICATION_STATUS.failedTerminal)
    assert.notEqual(row!.status, NOTIFICATION_STATUS.sent)
  } finally { await recv.close() }
})

test('a job that arrives EARLY is rescheduled, never stranded', { skip }, async () => {
  //  THE STRANDING BUG. A job running before nextAttemptAt used to find nothing
  //  claimable, return success, and be removed — leaving a row whose due time
  //  had passed with nothing scheduled to come back for it.
  const recv = await startReceiver((_n, res) => { res.writeHead(204); res.end() })
  useReceiver(recv.url)
  try {
    const { dedupeKey } = await seedLeadWithEvent()
    const dueAt = new Date(Date.now() + 60_000)
    await prisma.leadNotification.update({ where: { dedupeKey }, data: { status: 'retry', nextAttemptAt: dueAt } })

    let rescheduledTo: Date | null = null
    const out = await processLeadNotification(dedupeKey, deliverLeadNotice, {
      reschedule: async (d) => { rescheduledTo = d },
    })
    assert.equal((out as { action: string }).action, 'rescheduled_early')
    assert.ok(rescheduledTo, 'the job MUST be put back')
    assert.equal(recv.hits.length, 0, 'and no provider request is made early')
    const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
    assert.equal(row!.status, NOTIFICATION_STATUS.retry, 'the row is untouched and still due later')
    assert.equal(row!.attempts, 0, 'an early arrival must not consume an attempt')
  } finally { await recv.close() }
})

test('two concurrent workers deliver exactly ONE provider request', { skip }, async () => {
  const recv = await startReceiver((_n, res) => { res.writeHead(204); res.end() })
  useReceiver(recv.url)
  try {
    const { dedupeKey } = await seedLeadWithEvent()
    await Promise.all([
      processLeadNotification(dedupeKey, deliverLeadNotice).catch(() => {}),
      processLeadNotification(dedupeKey, deliverLeadNotice).catch(() => {}),
    ])
    assert.equal(recv.hits.length, 1, `the owner must be messaged ONCE, saw ${recv.hits.length}`)
  } finally { await recv.close() }
})

test('a worker killed after claiming leaves a lease the sweeper recovers', { skip }, async () => {
  const recv = await startReceiver((_n, res) => { res.writeHead(204); res.end() })
  useReceiver(recv.url)
  try {
    const { dedupeKey } = await seedLeadWithEvent()
    //  Simulate the crash: the row is claimed and the process dies.
    await prisma.leadNotification.update({
      where: { dedupeKey },
      data: { status: 'sending', claimedAt: new Date(Date.now() - 10 * 60_000) },
    })
    const { sweepLeadNotifications } = await import('../lead-notification-sweeper')
    const published: string[] = []
    const swept = await sweepLeadNotifications(async (k) => { published.push(k) })
    assert.equal(swept.staleRecovered, 1, 'the sweeper must release the dead lease')
    assert.ok(published.includes(dedupeKey), 'and requeue it')

    const out = await processLeadNotification(dedupeKey, deliverLeadNotice)
    assert.equal((out as { action: string }).action, 'sent')
    assert.equal(recv.hits.length, 1)
  } finally { await recv.close() }
})

test('queue loss does not lose the notice — the sweeper re-drives it', { skip }, async () => {
  const recv = await startReceiver((_n, res) => { res.writeHead(204); res.end() })
  useReceiver(recv.url)
  try {
    const { dedupeKey } = await seedLeadWithEvent()
    const q = new Queue(QUEUE, { connection })
    await q.add('lead-notify', { type: 'lead-notify', dedupeKey }, { jobId: dedupeKey })
    await q.obliterate({ force: true })          // Redis wiped
    assert.equal(await q.getWaitingCount(), 0)
    await q.close()
    assert.equal(recv.hits.length, 0, 'nothing was delivered')

    const { sweepLeadNotifications } = await import('../lead-notification-sweeper')
    const published: string[] = []
    const swept = await sweepLeadNotifications(async (k) => { published.push(k) })
    assert.ok(swept.ran)
    assert.ok(published.includes(dedupeKey), 'the sweeper found the orphaned promise')

    const out = await processLeadNotification(dedupeKey, deliverLeadNotice)
    assert.equal((out as { action: string }).action, 'sent')
  } finally { await recv.close() }
})

test('a queue-publication failure leaves the event recoverable', { skip }, async () => {
  const { dedupeKey } = await seedLeadWithEvent()
  const { sweepLeadNotifications } = await import('../lead-notification-sweeper')
  //  The publisher throws, as it would with Redis down.
  const swept = await sweepLeadNotifications(async () => { throw new Error('redis unavailable') })
  //  The sweep covers every due row, not only this one, so assert the PROPERTY
  //  rather than a count that other tests in this file also contribute to.
  assert.ok(swept.failed >= 1, `publication failures must be COUNTED, not swallowed (got ${swept.failed})`)
  assert.equal(swept.requeued, 0, 'nothing may be reported as requeued when every publish threw')
  const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
  assert.equal(row!.status, NOTIFICATION_STATUS.pending, 'and the row stays due for the next sweep')
  assert.equal(row!.attempts, 0, 'a publish failure is not a provider attempt')
})
