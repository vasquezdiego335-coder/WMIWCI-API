// ════════════════════════════════════════════════════════════════════════
//  lifecycle.enqueue_retry_backlog — the health check, run for real.
//  (production reliability release 2026-09-15)
//  ---------------------------------------------------------------------
//  A durable retry row is only worth writing if somebody notices when it is
//  NOT being drained. This check is what notices, so its judgement is the
//  thing worth testing:
//    • a fresh backlog is normal — the sweep runs hourly, so it must be quiet;
//    • a row still pending after 2h means the sweep is not draining it: warn;
//    • a row pending after 6h, or ANY row abandoned as too late in the last
//      24h (a customer message genuinely skipped), is critical — and only a
//      critical reaches the ops alert;
//    • a row closed by a CANCELLATION is the system working and must never
//      page anyone;
//    • the evidence is counts. The rows hold job payloads; the finding must
//      not carry a recipient address.
//
//  PRISMA. src/lib/db.ts resolves `globalThis.prisma ?? new PrismaClient()`
//  exactly once, on first import — so the proxy below is installed BEFORE any
//  module that imports db.ts is loaded, and every import here is therefore
//  DYNAMIC (a static one would evaluate db.ts first and this suite would try
//  to reach a database). Any table other than lifecycle_enqueue_retries throws
//  loudly rather than reaching one.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertNoProductionCredentials } from './_disposable-test-env'
import type { MemoryRetryDb } from './_lifecycle-retry-memory-db'
import type { LifecyclePath, RetryPrismaClient, RetryStore } from '../lifecycle-enqueue'

assertNoProductionCredentials()

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const NOW = new Date('2026-09-15T15:00:00.000Z')
const BOOKING = 'bk_backlog_1'

// Installed before the first dynamic import below.
let delegate: unknown = null
;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === 'then') return undefined
      if (prop === 'lifecycleEnqueueRetry') {
        if (!delegate) throw new Error('fake prisma: the in-memory retry table was read before it was installed')
        return delegate
      }
      throw new Error(`fake prisma: this check must only read lifecycle_enqueue_retries, not prisma.${String(prop)}`)
    },
  }
)

type World = { db: MemoryRetryDb; store: RetryStore; cancelled: string; tooLate: string }
let world: World | null = null

async function boot(): Promise<World> {
  if (world) return world
  const mem = await import('./_lifecycle-retry-memory-db')
  const le = await import('../lifecycle-enqueue')
  const db = mem.memoryRetryDb()
  delegate = db.delegate
  world = {
    db,
    store: le.prismaRetryStore({ lifecycleEnqueueRetry: db.delegate } as RetryPrismaClient),
    cancelled: le.CANCELLED_REASON,
    tooLate: le.TOO_LATE_REASON,
  }
  return world
}

/** Record one failed enqueue, exactly as a live path would. */
async function recordFailure(jobId: string, over: { createdAt?: Date } = {}): Promise<World> {
  const w = await boot()
  await w.store.recordFailure(
    {
      queueName: 'scheduled',
      jobName: 'abandoned-checkout-recovery',
      jobId,
      // The row holds the real job payload, recipient and all.
      data: { type: 'abandoned-checkout-recovery', bookingId: BOOKING, to: 'backlog@example.com' },
      fireAt: new Date(NOW.getTime() - HOUR),
      notAfter: new Date(NOW.getTime() + 2 * HOUR),
      path: 'abandoned-checkout' as LifecyclePath,
      subjectType: 'booking',
      subjectId: BOOKING,
    },
    'Connection is closed.',
    NOW
  )
  if (over.createdAt) w.db.byJobId(jobId)!.createdAt = over.createdAt
  return w
}

type Finding = { severity: string; title: string; description: string; fingerprint: string; evidence: Record<string, unknown> }

async function runCheck(): Promise<{ findings: Finding[]; inspected: Record<string, number> }> {
  const { sendChecks } = await import('../email-agent/checks/send')
  const { envDefaults } = await import('../email-agent/settings')
  const check = sendChecks.find((c) => c.id === 'lifecycle.enqueue_retry_backlog')
  assert.ok(check, 'the check must be registered in the send family')
  const ctx = {
    now: NOW,
    settings: { ...envDefaults(), mode: 'read_only' as const, stageRecipientLimit: 50 },
    windowHours: 24,
    inspected: {} as Record<string, number>,
    dryRun: true,
  }
  const findings = (await check.run(ctx)) as unknown as Finding[]
  return { findings, inspected: ctx.inspected }
}

const fresh = async (): Promise<World> => {
  const w = await boot()
  w.db.reset()
  return w
}

test('an empty retry table is silent', async () => {
  await fresh()
  const { findings, inspected } = await runCheck()
  assert.deepEqual(findings, [])
  assert.equal(inspected.lifecycle_retries_pending, 0, 'coverage is still reported')
})

test('a FRESH backlog is silent — the sweep runs hourly and is allowed to', async () => {
  await fresh()
  await recordFailure('journey__abandoned__abandoned-checkout-recovery__bk_fresh')
  const { findings, inspected } = await runCheck()
  assert.deepEqual(findings, [], 'a row minutes old is the system working as designed')
  assert.equal(inspected.lifecycle_retries_pending, 1)
})

test('a row pending for more than 2h is a WARNING', async () => {
  await fresh()
  await recordFailure('journey__abandoned__abandoned-checkout-recovery__bk_stale', {
    createdAt: new Date(NOW.getTime() - 3 * HOUR),
  })
  const { findings } = await runCheck()

  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'warning')
  assert.match(findings[0].title, /waiting to be re-queued for over 2h/)
  assert.equal(findings[0].evidence.pendingOlderThan2h, 1)
  assert.equal(findings[0].evidence.pendingOlderThan6h, 0)
})

test('a row pending for more than 6h is CRITICAL — the sweep is not running', async () => {
  await fresh()
  await recordFailure('journey__abandoned__abandoned-checkout-recovery__bk_dead', {
    createdAt: new Date(NOW.getTime() - 7 * HOUR),
  })
  const { findings } = await runCheck()

  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'critical', 'only a critical reaches the ops alert')
  assert.equal(findings[0].evidence.pendingOlderThan6h, 1)
})

test('a message skipped as TOO LATE is critical even when nothing is pending', async () => {
  const w = await fresh()
  await recordFailure('journey__abandoned__abandoned-checkout-recovery__bk_late')
  await w.store.markAbandoned(w.db.rows[0].id, w.tooLate, new Date(NOW.getTime() - HOUR))
  const { findings } = await runCheck()

  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'critical')
  assert.match(findings[0].title, /skipped after failing to queue/)
  assert.equal(findings[0].evidence.abandonedLast24h, 1)
})

test('a row closed by a CANCELLATION never pages anyone', async () => {
  const w = await fresh()
  await recordFailure('journey__pre-move__job-reminder-72h__bk_cancelled')
  await w.store.abandonForJobIds([w.db.rows[0].jobId], w.cancelled, new Date(NOW.getTime() - HOUR))
  const { findings } = await runCheck()

  assert.deepEqual(findings, [], 'cancelling a stage is the system working, not an incident')
})

test('the finding carries counts, never a recipient address', async () => {
  const w = await fresh()
  await recordFailure('journey__abandoned__abandoned-checkout-recovery__bk_redact', {
    createdAt: new Date(NOW.getTime() - 7 * HOUR),
  })
  assert.ok(JSON.stringify(w.db.rows[0].data).includes('@example.com'), 'the row really does hold an address')

  const { findings } = await runCheck()
  assert.equal(findings.length, 1)
  assert.ok(!JSON.stringify(findings[0]).includes('@'), 'and none of it reaches the finding')
  assert.deepEqual(Object.keys(findings[0].evidence).sort(), [
    'abandonedLast24h',
    'enqueued',
    'lostInThisProcess',
    'pending',
    'pendingOlderThan2h',
    'pendingOlderThan6h',
  ])
})

test('one backlog is ONE finding, with a stable fingerprint', async () => {
  await fresh()
  await recordFailure('journey__abandoned__abandoned-checkout-recovery__bk_a', { createdAt: new Date(NOW.getTime() - 7 * HOUR) })
  await recordFailure('journey__abandoned__abandoned-checkout-recovery__bk_b', { createdAt: new Date(NOW.getTime() - 7 * HOUR) })
  const first = await runCheck()
  const second = await runCheck()

  assert.equal(first.findings.length, 1, 'two stale rows are ONE backlog, not two alerts')
  assert.equal(first.findings[0].evidence.pendingOlderThan6h, 2)
  assert.equal(
    first.findings[0].fingerprint,
    second.findings[0].fingerprint,
    'a stable fingerprint is what lets the alert deduper stay quiet'
  )
})
