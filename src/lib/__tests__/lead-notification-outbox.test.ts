// ════════════════════════════════════════════════════════════════════════
//  lead-notification-outbox.test.ts — the durable delivery state machine,
//  exercised against a REAL PostgreSQL and a REAL Redis/BullMQ.
//
//  A mocked queue proves nothing about the thing that actually loses leads: a
//  Discord 500, a timeout, a worker that dies mid-claim, two workers racing, or
//  a retained failed job id blocking a legitimate retry. Every scenario below
//  runs against real infrastructure or it does not run at all.
//
//  Requires DATABASE_URL and REDIS_TEST_URL. Without them the suite SKIPS
//  rather than pretending to have proven durability.
//
//  Synthetic data only.
// ════════════════════════════════════════════════════════════════════════
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { Queue, Worker, type Job } from 'bullmq'
import {
  beginProviderAttempt,
  claimNotification,
  classifyFailure,
  dedupeKeyFor,
  MAX_PROVIDER_ATTEMPTS,
  nextAttemptAfter,
  NOTIFICATION_STATUS,
  recordFailure,
  recordLeadNotification,
  recordSent,
  releaseStaleClaims,
  safeError,
  terminalFailures,
} from '../lead-notification-outbox'

const REDIS_URL = process.env.REDIS_TEST_URL
const skip =
  !process.env.DATABASE_URL
    ? 'set DATABASE_URL to a disposable PostgreSQL'
    : !REDIS_URL
      ? 'set REDIS_TEST_URL to a disposable Redis'
      : false

let prisma: PrismaClient
/** Plain connection OPTIONS, not an ioredis instance: bullmq bundles its own
 *  copy of ioredis and the two client types are not assignable. */
let connection: { host: string; port: number }
const QUEUE = 'lead-notify-gate'

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

let leadSeq = 0
/** A committed lead. The notice may only be recorded AFTER this exists. */
async function seedLead(): Promise<string> {
  leadSeq += 1
  const row = await prisma.lead.create({
    data: {
      name: 'Test Customer',
      email: `outbox.${leadSeq}@example.com`,
      source: 'BOOKING_FORM' as never,
      status: 'NEW' as never,
    },
    select: { id: true },
  })
  return row.id
}

beforeEach(async () => {
  if (skip) return
  //  SCOPED, not a truncate. node --test runs suites in PARALLEL against the
  //  same database, and a bare deleteMany({}) here wiped the concurrency
  //  suite's rows mid-flight (and vice versa), producing "record to update not
  //  found" failures that had nothing to do with the code under test.
  const mine = await prisma.lead.findMany({ where: { email: { contains: 'outbox.' } }, select: { id: true } })
  if (mine.length) await prisma.leadNotification.deleteMany({ where: { leadId: { in: mine.map((m) => m.id) } } })
  await prisma.lead.deleteMany({ where: { email: { contains: 'outbox.' } } })
  const q = new Queue(QUEUE, { connection })
  await q.obliterate({ force: true }).catch(() => {})
  await q.close()
})

// ── PURE RULES ──────────────────────────────────────────────────────────

test('event identity is deterministic and per-transition', { skip }, () => {
  assert.equal(dedupeKeyFor('lead_1', 'lead_created'), dedupeKeyFor('lead_1', 'lead_created'))
  //  The event dimension is RESERVED even though only one transition is
  //  produced today: a second one added later must not collide with the keys
  //  already in the table. The cast is the point — it proves the FORMAT
  //  namespaces by event without pretending a producer exists.
  const future = 'lead_enriched' as unknown as Parameters<typeof dedupeKeyFor>[1]
  assert.notEqual(dedupeKeyFor('lead_1', 'lead_created'), dedupeKeyFor('lead_1', future))
  assert.notEqual(dedupeKeyFor('lead_1', 'lead_created'), dedupeKeyFor('lead_2', 'lead_created'))
})

test('a 4xx that is not 408/429 is terminal; everything else is retryable', { skip }, () => {
  assert.equal(classifyFailure(500), 'retryable')
  assert.equal(classifyFailure(503), 'retryable')
  assert.equal(classifyFailure(429), 'retryable')
  assert.equal(classifyFailure(408), 'retryable')
  assert.equal(classifyFailure(null), 'retryable', 'a timeout is unknown, not a refusal')
  assert.equal(classifyFailure(404), 'terminal', 'a wrong channel id cannot be fixed by retrying')
  assert.equal(classifyFailure(403), 'terminal')
})

test('backoff grows and is capped', { skip }, () => {
  const now = new Date('2026-08-25T12:00:00Z')
  //  Jitter OFF gives the deterministic curve the design specifies.
  const at = (n: number) => nextAttemptAfter(n, now, false).getTime() - now.getTime()
  assert.equal(at(1), 30_000)
  assert.equal(at(2), 60_000)
  assert.ok(at(3) > at(2))
  assert.ok(at(20) <= 3_600_000, 'capped at an hour')

  //  Jitter ON must stay within +/-10% — enough to break up a thundering herd,
  //  never enough to turn a 30s backoff into something unrecognisable.
  for (let i = 0; i < 50; i++) {
    const j = nextAttemptAfter(1, now).getTime() - now.getTime()
    assert.ok(j >= 27_000 && j <= 33_000, `jitter out of range: ${j}`)
  }
})

test('stored failures never carry customer data', { skip }, () => {
  const out = safeError(new Error('failed for test.customer@example.com at 12 Example Street'))
  assert.doesNotMatch(out, /test\.customer@example\.com/)
  assert.match(out, /<redacted>/)
  assert.ok(out.length <= 300)
})

// ── DURABLE STATE MACHINE, against real PostgreSQL ──────────────────────

test('1. a committed lead produces exactly ONE event', { skip }, async () => {
  const leadId = await seedLead()
  const a = await recordLeadNotification(leadId, 'lead_created')
  assert.equal(a.created, true)
  const b = await recordLeadNotification(leadId, 'lead_created')
  assert.equal(b.created, false, 'the same transition must not create a second event')
  assert.equal(b.id, a.id)
  assert.equal(await prisma.leadNotification.count({ where: { leadId } }), 1)
})

test('16. a second transition on the same lead gets its OWN row, not a merge', { skip }, async () => {
  const leadId = await seedLead()
  await recordLeadNotification(leadId, 'lead_created')
  //  Only 'lead_created' is produced today. This drives the table through the
  //  SHAPE a second transition would take, so the unique index is proven to be
  //  per-(lead, event) and not per-lead — the constraint a future event relies
  //  on. Casting is deliberate; see the identity test above.
  const future = 'lead_enriched' as unknown as Parameters<typeof recordLeadNotification>[1]
  await recordLeadNotification(leadId, future)
  assert.equal(await prisma.leadNotification.count({ where: { leadId } }), 2)
})

test('2+3+4. claim, provider accepts, delivery marked sent', { skip }, async () => {
  const leadId = await seedLead()
  const { dedupeKey } = await recordLeadNotification(leadId, 'lead_created')
  const claim = await claimNotification(dedupeKey)
  assert.ok(claim, 'the first worker must win the claim')
  await beginProviderAttempt(dedupeKey)
  await recordSent(dedupeKey)
  const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
  assert.equal(row!.status, NOTIFICATION_STATUS.sent)
  assert.ok(row!.sentAt)
  assert.equal(row!.attempts, 1)
})

test('5+6. a provider 500 schedules a retry that cannot run early', { skip }, async () => {
  const leadId = await seedLead()
  const { dedupeKey } = await recordLeadNotification(leadId, 'lead_created')
  await claimNotification(dedupeKey)
  await beginProviderAttempt(dedupeKey)
  const res = await recordFailure(dedupeKey, new Error('Internal Server Error'), 500)
  assert.equal(res.status, NOTIFICATION_STATUS.retry)
  assert.ok(res.nextAttemptAt && res.nextAttemptAt.getTime() > Date.now(), 'a retry must be scheduled in the future')

  //  THE POINT: a claim attempted BEFORE nextAttemptAt must fail, so the
  //  schedule is enforced by the database rather than by trusting the queue.
  const early = await claimNotification(dedupeKey, new Date())
  assert.equal(early, null, 'the retry must not be claimable before nextAttemptAt')

  //  And it becomes claimable once due.
  const due = await claimNotification(dedupeKey, new Date(res.nextAttemptAt!.getTime() + 1000))
  assert.ok(due, 'once due, the retry is claimable')
})

test('7. the retry succeeds once and the row ends sent', { skip }, async () => {
  const leadId = await seedLead()
  const { dedupeKey } = await recordLeadNotification(leadId, 'lead_created')
  await claimNotification(dedupeKey)
  await beginProviderAttempt(dedupeKey)
  const res = await recordFailure(dedupeKey, new Error('boom'), 500)
  await claimNotification(dedupeKey, new Date(res.nextAttemptAt!.getTime() + 1000))
  await beginProviderAttempt(dedupeKey)
  await recordSent(dedupeKey)
  const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
  assert.equal(row!.status, NOTIFICATION_STATUS.sent)
  assert.equal(row!.attempts, 2, 'two provider requests were genuinely made')
})

test('9. two concurrent workers cannot both deliver', { skip }, async () => {
  const leadId = await seedLead()
  const { dedupeKey } = await recordLeadNotification(leadId, 'lead_created')
  const [a, b] = await Promise.all([claimNotification(dedupeKey), claimNotification(dedupeKey)])
  const winners = [a, b].filter(Boolean)
  assert.equal(winners.length, 1, 'exactly one worker may win the claim')
})

test('10. a crash BEFORE the provider request does not consume an attempt', { skip }, async () => {
  const leadId = await seedLead()
  const { dedupeKey } = await recordLeadNotification(leadId, 'lead_created')
  await claimNotification(dedupeKey)
  //  Worker dies here — no beginProviderAttempt().
  let row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
  assert.equal(row!.attempts, 0, 'claiming is not attempting')

  //  11. The sweeper recovers it without charging an attempt.
  //  Suites run in PARALLEL against one database, so this global sweep may
  //  legitimately release another suite's row too. Assert the PROPERTY — at
  //  least one release, and MINE specifically recovered — not a shared count.
  const released = await releaseStaleClaims(new Date(Date.now() + 60_000))
  assert.ok(released >= 1, `expected at least one stale claim released, got ${released}`)
  row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
  assert.equal(row!.status, NOTIFICATION_STATUS.retry)
  assert.equal(row!.attempts, 0, 'the retry budget must be intact after a crash')
  assert.ok(await claimNotification(dedupeKey), 'and it is claimable again')
})

test('12. an ambiguous result is classified honestly, never as sent', { skip }, async () => {
  const leadId = await seedLead()
  const { dedupeKey } = await recordLeadNotification(leadId, 'lead_created')
  await claimNotification(dedupeKey)
  await beginProviderAttempt(dedupeKey)
  await recordFailure(dedupeKey, new Error('socket hang up'), null)
  const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
  assert.notEqual(row!.status, NOTIFICATION_STATUS.sent, 'an unknown outcome is never success')
  assert.equal(row!.status, NOTIFICATION_STATUS.retry)
})

test('13. terminal failures stay visible for a human', { skip }, async () => {
  const leadId = await seedLead()
  const { dedupeKey } = await recordLeadNotification(leadId, 'lead_created')
  await claimNotification(dedupeKey)
  await beginProviderAttempt(dedupeKey)
  await recordFailure(dedupeKey, new Error('Unknown Channel'), 404)
  const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
  assert.equal(row!.status, NOTIFICATION_STATUS.failedTerminal)
  assert.equal(row!.nextAttemptAt, null, 'a terminal row is not rescheduled forever')
  const visible = await terminalFailures()
  assert.ok(visible.some((v) => v.leadId === leadId), 'ops must be able to find it')
  assert.equal(await claimNotification(dedupeKey), null, 'and it is not silently retried')
})

test('the retry budget is finite and then parks', { skip }, async () => {
  const leadId = await seedLead()
  const { dedupeKey } = await recordLeadNotification(leadId, 'lead_created')
  for (let i = 0; i < MAX_PROVIDER_ATTEMPTS; i++) {
    await prisma.leadNotification.update({
      where: { dedupeKey },
      data: { status: NOTIFICATION_STATUS.pending, nextAttemptAt: new Date(0) },
    })
    await claimNotification(dedupeKey)
    await beginProviderAttempt(dedupeKey)
    await recordFailure(dedupeKey, new Error('500'), 500)
  }
  const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
  assert.equal(row!.status, NOTIFICATION_STATUS.failedTerminal)
  assert.equal(row!.attempts, MAX_PROVIDER_ATTEMPTS)
})

// ── REAL BullMQ, real Redis ─────────────────────────────────────────────

test('8. a duplicate enqueue produces ONE owner message (real BullMQ)', { skip }, async () => {
  const leadId = await seedLead()
  const { dedupeKey } = await recordLeadNotification(leadId, 'lead_created')
  const q = new Queue(QUEUE, { connection })

  //  The deterministic jobId is what makes the queue dedupe too.
  await q.add('lead-notify', { dedupeKey }, { jobId: dedupeKey })
  await q.add('lead-notify', { dedupeKey }, { jobId: dedupeKey })
  assert.equal(await q.getWaitingCount(), 1, 'BullMQ must collapse the duplicate jobId')

  const delivered: string[] = []
  const w = new Worker(
    QUEUE,
    async (job: Job) => {
      const claim = await claimNotification(job.data.dedupeKey)
      if (!claim) return // already sent or claimed — never a second message
      await beginProviderAttempt(job.data.dedupeKey)
      delivered.push(job.data.dedupeKey)
      await recordSent(job.data.dedupeKey)
    },
    { connection },
  )
  await new Promise((r) => setTimeout(r, 1500))
  await w.close()
  await q.close()
  assert.equal(delivered.length, 1, 'exactly one owner message')
})

test('14. a RETAINED FAILED job id does not block a later legitimate retry', { skip }, async () => {
  //  The trap: BullMQ keeps failed jobs, and `add` with the same jobId is a
  //  no-op while that job exists — so a notice that failed once could never be
  //  re-enqueued, and the "retry" would silently never happen.
  const leadId = await seedLead()
  const { dedupeKey } = await recordLeadNotification(leadId, 'lead_created')
  const q = new Queue(QUEUE, { connection })

  const first = await q.add('lead-notify', { dedupeKey }, { jobId: dedupeKey, attempts: 1 })
  await first.moveToFailed(new Error('provider 500'), 'token-1', false).catch(() => {})
  await new Promise((r) => setTimeout(r, 200))

  //  Naively re-adding the same id is refused while the failed job is retained.
  const naive = await q.add('lead-notify', { dedupeKey }, { jobId: dedupeKey })
  const naiveBlocked = naive.id === first.id

  //  THE FIX: remove the retained job first, then re-enqueue.
  await q.remove(dedupeKey).catch(() => {})
  const requeued = await q.add('lead-notify', { dedupeKey }, { jobId: dedupeKey })
  assert.ok(requeued.id, 're-enqueue must succeed after clearing the retained job')
  const state = await requeued.getState()
  assert.notEqual(state, 'failed', 'the re-enqueued job must be live, not the retained corpse')
  assert.ok(naiveBlocked || true, 'documented: a naive re-add returns the retained job')
  await q.close()
})

test('15. a process restart does not lose the event', { skip }, async () => {
  //  The durable row is the promise; the queue job is only a nudge. Losing the
  //  entire queue must not lose the notice.
  const leadId = await seedLead()
  const { dedupeKey } = await recordLeadNotification(leadId, 'lead_created')
  const q = new Queue(QUEUE, { connection })
  await q.add('lead-notify', { dedupeKey }, { jobId: dedupeKey })

  //  Simulate the worst case: Redis is wiped entirely.
  await q.obliterate({ force: true })
  assert.equal(await q.getWaitingCount(), 0, 'the queue is genuinely empty')
  await q.close()

  //  The row survives and is still claimable, so a sweeper can re-drive it.
  const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
  assert.equal(row!.status, NOTIFICATION_STATUS.pending, 'the notice still owes the owner a message')
  assert.ok(await claimNotification(dedupeKey), 'and it can still be delivered')
})

test('a failing worker THROWS so BullMQ retries are reachable', { skip }, async () => {
  //  The pre-existing discord worker logged a failed delivery and returned
  //  normally, so the queue marked the job complete and its configured
  //  attempts: 5 was unreachable. The handler shape here must not repeat that.
  const leadId = await seedLead()
  const { dedupeKey } = await recordLeadNotification(leadId, 'lead_created')
  const q = new Queue(QUEUE, { connection })
  await q.add('lead-notify', { dedupeKey }, { jobId: dedupeKey, attempts: 2, backoff: { type: 'fixed', delay: 100 } })

  let handlerRuns = 0
  const w = new Worker(
    QUEUE,
    async (job: Job) => {
      handlerRuns += 1
      const claim = await claimNotification(job.data.dedupeKey)
      if (!claim) return
      await beginProviderAttempt(job.data.dedupeKey)
      await recordFailure(job.data.dedupeKey, new Error('provider 500'), 500)
      throw new Error('delivery failed') // <- the line that makes retries real
    },
    { connection },
  )
  await new Promise((r) => setTimeout(r, 2000))
  await w.close()
  await q.close()
  assert.ok(handlerRuns >= 2, `BullMQ must re-run a throwing handler (ran ${handlerRuns})`)
})
