// ════════════════════════════════════════════════════════════════════════
//  lifecycle_enqueue_retries — the table's own invariants, on real Postgres.
//  (production reliability release 2026-09-15)
//  ---------------------------------------------------------------------
//  WHY THIS NEEDS A DATABASE. The durable-enqueue store leans on TWO things a
//  fake cannot exhibit:
//    1. the UNIQUE index on job_id. A booking's checkout can fail to enqueue
//       from two requests at once (the webhook and the success redirect arrive
//       together); the constraint is what collapses those into ONE row instead
//       of two rows that both get swept and re-added.
//    2. the conditional status transitions. `markEnqueued` only moves a PENDING
//       row, so a cancel that lands mid-sweep wins, and a sweep cannot reopen a
//       row someone closed.
//
//  Runs against a DISPOSABLE Postgres (CI service container). Every row this
//  suite writes carries a unique per-run job-id prefix and is deleted in
//  `after`, so parallel suites sharing one database cannot collide. No Redis:
//  the queue is a fake, because the point here is the table, not BullMQ.
// ════════════════════════════════════════════════════════════════════════
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { assertNoProductionCredentials, dbSkip } from './_disposable-test-env'
import {
  CANCELLED_REASON,
  TOO_LATE_REASON,
  enqueueDurable,
  prismaRetryStore,
  type LifecyclePath,
  type QueueLike,
  type RetryStore,
} from '../lifecycle-enqueue'
import { runLifecycleRetrySweep, sweepShiftFor, type LifecycleRetrySweepDeps } from '../lifecycle-retry-sweep'

// A production-looking DATABASE_URL / Redis URL / Resend key is a HARD
// FAILURE, never a skip — see _disposable-test-env.ts.
const skip = dbSkip()
assertNoProductionCredentials()

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const NOW = new Date('2026-09-15T15:00:00.000Z')
const now = () => NOW
/** Unique to this run: nothing else in the table is ever touched. */
const PREFIX = `test_retry_${process.pid}_${Date.now()}`

let prisma: PrismaClient
let store: RetryStore

before(async () => {
  if (skip) return
  prisma = new PrismaClient()
  await prisma.$connect()
  store = prismaRetryStore(prisma)
})

after(async () => {
  if (skip) return
  await prisma.lifecycleEnqueueRetry.deleteMany({ where: { jobId: { startsWith: PREFIX } } })
  await prisma.$disconnect()
})

// ── a queue that always refuses, so every add records instead ───────────
type FakeQueue = QueueLike & { added: string[] }
function fakeQueue(name = 'scheduled', mode: 'ok' | 'false' = 'false'): FakeQueue {
  const added: string[] = []
  return {
    name,
    added,
    async add(_jobName: string, _data: unknown, opts?: { delay?: number; jobId?: string }) {
      if (mode === 'false') return false
      added.push(String(opts?.jobId))
      return { id: opts?.jobId }
    },
  }
}

const input = (jobId: string, over: { fireAt?: Date; notAfter?: Date } = {}) => ({
  queue: fakeQueue(),
  name: 'abandoned-checkout-recovery',
  data: { type: 'abandoned-checkout-recovery', bookingId: `${PREFIX}_booking` },
  jobId,
  fireAt: over.fireAt ?? new Date(NOW.getTime() + 45 * MINUTE),
  notAfter: over.notAfter ?? new Date(NOW.getTime() + 4 * HOUR),
  path: 'abandoned-checkout' as LifecyclePath,
  subjectType: 'booking' as const,
  subjectId: `${PREFIX}_booking`,
})

const sweepDeps = (queues: Record<string, FakeQueue>): LifecycleRetrySweepDeps => ({
  store,
  queueFor: (name) => queues[name] ?? null,
  shiftFor: sweepShiftFor,
})

const rowFor = (jobId: string) => prisma.lifecycleEnqueueRetry.findUnique({ where: { jobId } })

test('ten concurrent failures for ONE job id leave exactly ONE row', { skip }, async () => {
  const jobId = `${PREFIX}_concurrent`
  const results = await Promise.all(Array.from({ length: 10 }, () => enqueueDurable(input(jobId), { store, now })))

  assert.deepEqual(new Set(results.map((r) => r.status)), new Set(['recorded_for_retry']), 'every caller is told the truth')
  const rows = await prisma.lifecycleEnqueueRetry.findMany({ where: { jobId } })
  assert.equal(rows.length, 1, `the unique job_id index must collapse the burst, found ${rows.length}`)
  assert.equal(rows[0].status, 'pending')
  assert.ok(rows[0].attempts >= 1, 'at least the first failure is counted')
  assert.equal((rows[0].data as unknown as { bookingId?: string }).bookingId, `${PREFIX}_booking`)
  assert.equal(rows[0].resolvedAt, null)
})

test('the recorded row holds the EXACT job the live path meant to add', { skip }, async () => {
  const jobId = `${PREFIX}_exact`
  const i = input(jobId)
  await enqueueDurable(i, { store, now })

  const row = (await rowFor(jobId))!
  assert.ok(row)
  assert.equal(row.queueName, 'scheduled')
  assert.equal(row.jobName, i.name)
  assert.deepEqual(row.data, i.data)
  assert.equal(row.fireAt.getTime(), i.fireAt.getTime())
  assert.equal(row.notAfter.getTime(), i.notAfter.getTime())
  assert.equal(row.path, 'abandoned-checkout')
  assert.equal(row.subjectType, 'booking')
  assert.equal(row.subjectId, `${PREFIX}_booking`)
  assert.ok(!(row.lastError ?? '').includes('@'), 'no recipient address is ever stored here')
})

test('the sweep moves pending → enqueued, exactly once', { skip }, async () => {
  const jobId = `${PREFIX}_sweep_ok`
  await enqueueDurable(input(jobId), { store, now })

  const queue = fakeQueue('scheduled', 'ok')
  const first = await runLifecycleRetrySweep({ now: NOW, limit: 50, deps: sweepDeps({ scheduled: queue }) })
  assert.ok(first.enqueued >= 1)
  assert.ok(queue.added.includes(jobId), 'the SAME deterministic id goes back to the queue')

  const row = (await rowFor(jobId))!
  assert.equal(row.status, 'enqueued')
  assert.equal(row.resolvedAt?.getTime(), NOW.getTime())

  const before = queue.added.length
  await runLifecycleRetrySweep({ now: NOW, limit: 50, deps: sweepDeps({ scheduled: queue }) })
  assert.ok(!queue.added.slice(before).includes(jobId), 'a closed row is never re-added')
})

test('a row past not_after is abandoned, and nothing is re-added', { skip }, async () => {
  const jobId = `${PREFIX}_too_late`
  await enqueueDurable(input(jobId, { notAfter: new Date(NOW.getTime() + HOUR) }), { store, now })

  const queue = fakeQueue('scheduled', 'ok')
  const late = new Date(NOW.getTime() + 2 * HOUR)
  await runLifecycleRetrySweep({ now: late, limit: 50, deps: sweepDeps({ scheduled: queue }) })

  const row = (await rowFor(jobId))!
  assert.equal(row.status, 'abandoned')
  assert.equal(row.lastError, TOO_LATE_REASON)
  assert.equal(row.resolvedAt?.getTime(), late.getTime())
  assert.ok(!queue.added.includes(jobId), 'history is never replayed')
})

test('a cancelled stage closes its row, and the sweep leaves it closed', { skip }, async () => {
  const jobId = `${PREFIX}_cancelled`
  await enqueueDurable(input(jobId), { store, now })

  const closed = await store.abandonForJobIds([jobId], CANCELLED_REASON, NOW)
  assert.equal(closed, 1)

  const queue = fakeQueue('scheduled', 'ok')
  await runLifecycleRetrySweep({ now: NOW, limit: 50, deps: sweepDeps({ scheduled: queue }) })

  const row = (await rowFor(jobId))!
  assert.equal(row.status, 'abandoned')
  assert.equal(row.lastError, CANCELLED_REASON)
  assert.ok(!queue.added.includes(jobId), 'a cancelled stage is never resurrected')
})

test('a re-schedule after a cancel re-opens the row; an ENQUEUED row is never re-opened', { skip }, async () => {
  const reopened = `${PREFIX}_reopen`
  await enqueueDurable(input(reopened), { store, now })
  await store.abandonForJobIds([reopened], CANCELLED_REASON, NOW)
  // The live path decided to schedule this stage again and failed again: that
  // is NEW work, so the row must come back.
  await enqueueDurable(input(reopened), { store, now })
  const back = (await rowFor(reopened))!
  assert.equal(back.status, 'pending')
  assert.equal(back.resolvedAt, null)

  const held = `${PREFIX}_held`
  await enqueueDurable(input(held), { store, now })
  const heldRow = (await rowFor(held))!
  assert.ok(await store.markEnqueued(heldRow.id, NOW))
  await enqueueDurable(input(held), { store, now })
  const after = (await rowFor(held))!
  assert.equal(after.status, 'enqueued', 'the sweep already put this job in Redis — do not re-add it')
  assert.ok(after.attempts > heldRow.attempts, 'the later failure is still counted for the operator')
})

test('status transitions are conditional: only a PENDING row can be closed or deferred', { skip }, async () => {
  const jobId = `${PREFIX}_transitions`
  await enqueueDurable(input(jobId), { store, now })
  const row = (await rowFor(jobId))!

  assert.equal(await store.markEnqueued(row.id, NOW), true)
  assert.equal(await store.markEnqueued(row.id, NOW), false, 'a second sweep cannot close it twice')
  assert.equal(await store.markAbandoned(row.id, TOO_LATE_REASON, NOW), false, 'and cannot abandon what it already enqueued')
  assert.equal(await store.markAttemptFailed(row.id, 'nope', new Date(NOW.getTime() + HOUR)), false)
  assert.equal((await rowFor(jobId))!.status, 'enqueued')
})

test('due() returns only pending rows that are due, oldest first', { skip }, async () => {
  const soon = `${PREFIX}_due_1`
  const later = `${PREFIX}_due_2`
  const notYet = `${PREFIX}_due_3`
  for (const id of [soon, later, notYet]) await enqueueDurable(input(id), { store, now })
  await prisma.lifecycleEnqueueRetry.update({ where: { jobId: soon }, data: { nextAttemptAt: new Date(NOW.getTime() - 10 * MINUTE) } })
  await prisma.lifecycleEnqueueRetry.update({ where: { jobId: later }, data: { nextAttemptAt: new Date(NOW.getTime() - MINUTE) } })
  await prisma.lifecycleEnqueueRetry.update({ where: { jobId: notYet }, data: { nextAttemptAt: new Date(NOW.getTime() + HOUR) } })

  const due = (await store.due(NOW, 100)).filter((r) => r.jobId.startsWith(PREFIX))
  const mine = due.map((r) => r.jobId)
  assert.ok(mine.indexOf(soon) > -1 && mine.indexOf(later) > mine.indexOf(soon), 'oldest due first')
  assert.ok(!mine.includes(notYet), 'a backed-off row waits its turn')
})

test('a failed re-add increments attempts and defers the row, bounded by not_after', { skip }, async () => {
  const jobId = `${PREFIX}_backoff`
  await enqueueDurable(input(jobId), { store, now })
  const before = (await rowFor(jobId))!

  // The queue is still refusing.
  await runLifecycleRetrySweep({ now: NOW, limit: 50, deps: sweepDeps({ scheduled: fakeQueue('scheduled', 'false') }) })

  const after = (await rowFor(jobId))!
  assert.equal(after.status, 'pending', 'still owed')
  assert.equal(after.attempts, before.attempts + 1)
  assert.ok(after.nextAttemptAt.getTime() > NOW.getTime())
  assert.ok(after.nextAttemptAt.getTime() <= after.notAfter.getTime())
})

test('summary counts the backlog and ignores cancellations', { skip }, async () => {
  const base = await store.summary(NOW)
  const stale = `${PREFIX}_stale`
  const cancelled = `${PREFIX}_summary_cancelled`
  const tooLate = `${PREFIX}_summary_late`
  for (const id of [stale, cancelled, tooLate]) await enqueueDurable(input(id), { store, now })
  await prisma.lifecycleEnqueueRetry.update({ where: { jobId: stale }, data: { createdAt: new Date(NOW.getTime() - 7 * HOUR) } })
  await store.abandonForJobIds([cancelled], CANCELLED_REASON, NOW)
  const lateRow = (await rowFor(tooLate))!
  await store.markAbandoned(lateRow.id, TOO_LATE_REASON, NOW)

  const s = await store.summary(NOW)
  assert.equal(s.pendingOlderThan2h - base.pendingOlderThan2h, 1)
  assert.equal(s.pendingOlderThan6h - base.pendingOlderThan6h, 1)
  assert.equal(s.abandonedLast24h - base.abandonedLast24h, 1, 'a cancellation is the system working, not an alert')
})

test('rows are never deleted by the sweep — the audit trail survives', { skip }, async () => {
  const kept = await prisma.lifecycleEnqueueRetry.count({ where: { jobId: { startsWith: PREFIX } } })
  await runLifecycleRetrySweep({ now: new Date(NOW.getTime() + 10 * HOUR), limit: 200, deps: sweepDeps({ scheduled: fakeQueue('scheduled', 'ok') }) })
  const after = await prisma.lifecycleEnqueueRetry.count({ where: { jobId: { startsWith: PREFIX } } })
  assert.equal(after, kept, 'every row this suite wrote is still there, whatever happened to it')
})
