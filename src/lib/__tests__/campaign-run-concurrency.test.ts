// ════════════════════════════════════════════════════════════════════════
//  campaign-run-concurrency.test.ts — one unfinished run per campaign, and
//  a settlement only its own attempt may write. Against REAL PostgreSQL.
//
//  THE DEFECT THIS PINS.
//
//  dispatchCampaign looked for an unfinished run, then did unlocked,
//  non-transactional work (audience resolution), then created one:
//
//      findFirst(unfinished) → preflight → emailCampaignRun.create(...)
//
//  Nothing stood between the check and the create — no lock, no transaction,
//  no database invariant. Two callers race in production every day: the admin
//  PATCH action=dispatch (a double-click, or two tabs, in the API service) and
//  the 15-minute campaign sweep (a SEPARATE process, the worker host). Both
//  could create a run — and because the send idempotency key is anchored on the
//  RUN id (`campaign-run:<runId>`), the two runs share nothing. Every recipient
//  could be emailed TWICE (the daily promotional cap only defers the second
//  copy by 24h; it still goes out).
//
//  The second defect is on the recipient row. `settle()` was an unconditional
//  update by id, so a worker that stalled past the 15-minute stale window —
//  after the sweep re-opened its row and a NEWER attempt claimed and settled
//  it — could still overwrite the newer attempt's result, at worst re-opening
//  a row that had already been SENT.
//
//  A MOCKED STORE CANNOT EXHIBIT EITHER RACE, which is exactly why both
//  survived. This suite runs the real claim path, the real advisory lock and
//  the real partial unique index against a disposable Postgres; the offline
//  halves are campaign-run-slot.test.ts and campaign-transient-suppression.test.ts.
//
//  NOTHING HERE CAN SEND. No path exercised reaches guardedSend or a queue:
//  the run-slot claim writes one row, and retryFailedRecipients returns before
//  its enqueue. EMAIL_PROMOTIONS_ENABLED is never set.
//
//  Synthetic data only; fixtures are scoped by generated id and cleaned up in
//  FK order (recipients → runs → campaigns), never truncated — parallel test
//  files share one CI database.
// ════════════════════════════════════════════════════════════════════════
import { test, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { dbSkip, assertNoProductionCredentials, assertTestRecipient } from './_disposable-test-env'
import { prisma } from '../db'
import { resend } from '../resend'
import { claimCampaignRunSlot, settleRecipient, retryFailedRecipients, SYSTEM_ACTOR } from '../email-campaign-dispatch'
import { RUN_SLOT_INDEX, UNFINISHED_RUN_STATES, isRunSlotConflict, recipientClaimWhere } from '../email-campaign-run'

assertNoProductionCredentials()
const skip = dbSkip()

const EMAIL = 'run.concurrency@example.com'
assertTestRecipient(EMAIL)

// Belt to the brace: no path here should reach the guard, let alone a provider.
// If one ever does, this throws instead of mailing anybody, and the last test
// proves it was never touched.
const sendSpy = mock.method(resend.emails, 'send', async () => {
  throw new Error('a test reached the real provider')
})

const campaignIds: string[] = []

async function makeCampaign(): Promise<string> {
  const c = await prisma.marketingCampaign.create({
    data: {
      name: `test run slot ${randomUUID()}`,
      channel: 'EMAIL',
      sourceKey: `test_run_slot_${randomUUID()}`,
      status: 'ACTIVE',
    },
    select: { id: true },
  })
  campaignIds.push(c.id)
  return c.id
}

const SLOT_DATA = {
  snapshot: { template: 'lead-nurture-final', subject: 'test', sourceKey: 'test' },
  preflight: { checkedAt: new Date().toISOString() },
  startedById: null,
  startedByName: 'concurrency test',
}

/** Generous transaction budget: ten callers queue behind one advisory lock on a
 *  small CI runner pool, and a pool wait must not be read as a real conflict. */
const TX = { maxWait: 20_000, timeout: 20_000 }

const unfinishedRuns = (campaignId: string) =>
  prisma.emailCampaignRun.findMany({ where: { campaignId, status: { in: [...UNFINISHED_RUN_STATES] } }, select: { id: true, status: true } })

/** One unfinished run row, written RAW so it bypasses the application entirely. */
async function rawInsertRun(campaignId: string, status: string): Promise<string> {
  const id = `run_${randomUUID()}`
  await prisma.$executeRawUnsafe(
    `INSERT INTO "email_campaign_runs" ("id","campaign_id","status","snapshot","started_at","updated_at")
     VALUES ($1,$2,$3,'{}'::jsonb, now(), now())`,
    id,
    campaignId,
    status
  )
  return id
}

before(async () => {
  if (skip) return
  await prisma.$connect()
})

after(async () => {
  if (skip) return
  if (campaignIds.length) {
    const runs = await prisma.emailCampaignRun.findMany({ where: { campaignId: { in: campaignIds } }, select: { id: true } })
    const runIds = runs.map((r) => r.id)
    // FK order: recipients RESTRICT their run (audit E-08), runs cascade from
    // the campaign. Scoped to this suite's own ids — never a truncate.
    if (runIds.length) await prisma.emailCampaignRecipient.deleteMany({ where: { runId: { in: runIds } } })
    if (runIds.length) await prisma.emailCampaignRun.deleteMany({ where: { id: { in: runIds } } })
    await prisma.marketingCampaign.deleteMany({ where: { id: { in: campaignIds } } })
  }
  await prisma.$disconnect()
})

// ── 1. The real race ────────────────────────────────────────────────────

test('10 concurrent slot claims create exactly ONE run — and everyone is told about it', { skip }, async () => {
  const campaignId = await makeCampaign()

  const results = await Promise.all(Array.from({ length: 10 }, () => claimCampaignRunSlot(campaignId, SLOT_DATA, prisma, TX)))

  const winners = results.filter((r) => r.claimed)
  assert.equal(winners.length, 1, `exactly ONE caller may create the run, got ${winners.length}`)
  const runId = winners[0].claimed ? winners[0].runId : ''

  for (const r of results) {
    if (r.claimed) continue
    assert.ok(r.existing, 'a loser must be handed the WINNER, never a bare conflict — a pool wait is not a refusal')
    assert.equal(r.existing.id, runId, 'every caller must converge on the same run')
  }

  const rows = await unfinishedRuns(campaignId)
  assert.equal(rows.length, 1, `the database must hold ONE unfinished run, found ${rows.length}`)
  assert.equal(rows[0].id, runId)

  // ZERO DUPLICATE RECIPIENTS. Every caller now writes the recipient list it
  // believes it owns, exactly as dispatchCampaign does. They all address the
  // same run, so UNIQUE(run_id, email) collapses them to one row; two runs
  // would have produced two rows with two different idempotency keys.
  await Promise.all(
    results.map((r) =>
      prisma.emailCampaignRecipient.createMany({
        data: [{ runId: r.claimed ? r.runId : r.existing!.id, email: EMAIL, status: 'PENDING', batchIndex: 0 }],
        skipDuplicates: true,
      })
    )
  )
  const recipients = await prisma.emailCampaignRecipient.count({ where: { run: { campaignId } } })
  assert.equal(recipients, 1, `one campaign, one person, ONE recipient row — found ${recipients}`)
})

test('the index alone holds when the lock is bypassed, and Prisma reports it the way the code expects', { skip }, async () => {
  const campaignId = await makeCampaign()

  // No advisory lock here on purpose: this is the mixed-version-deploy case
  // (old code, or any writer that does not take the lock). The DATABASE must
  // refuse, and isRunSlotConflict must recognise the REAL Prisma 5.22 error —
  // a Prisma upgrade that changes the shape fails here, not in production.
  const settled = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      prisma.emailCampaignRun.create({ data: { campaignId, status: 'PREPARING', snapshot: {} }, select: { id: true } })
    )
  )
  const ok = settled.filter((s) => s.status === 'fulfilled')
  assert.equal(ok.length, 1, `the partial unique index must let exactly ONE through, got ${ok.length} — is the migration applied?`)
  for (const s of settled) {
    if (s.status === 'fulfilled') continue
    assert.ok(isRunSlotConflict(s.reason), `every rejection must be recognised as the slot conflict, got ${JSON.stringify(s.reason)}`)
  }
})

test('the slot invariant is UNIQUE, VALID and covers exactly the unfinished states', { skip }, async () => {
  const rows = await prisma.$queryRawUnsafe<Array<{ indisunique: boolean; indisvalid: boolean; predicate: string | null }>>(
    `SELECT i.indisunique, i.indisvalid, pg_get_expr(i.indpred, i.indrelid) AS predicate
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'email_campaign_runs'::regclass AND c.relname = $1`,
    RUN_SLOT_INDEX
  )
  assert.equal(rows.length, 1, `${RUN_SLOT_INDEX} must exist — without it concurrent dispatches can email every recipient twice`)
  assert.equal(rows[0].indisunique, true, 'a non-unique index enforces nothing')
  // An interrupted CREATE INDEX CONCURRENTLY leaves an INVALID index of the
  // same name, which `IF NOT EXISTS` would then silently accept.
  assert.equal(rows[0].indisvalid, true, 'an INVALID index is not enforcing, however present it looks')
  const predicate = rows[0].predicate ?? ''
  assert.ok(predicate.length > 0, 'the index must be PARTIAL — a campaign legitimately has many FINISHED runs')
  for (const s of UNFINISHED_RUN_STATES) assert.ok(predicate.includes(`'${s}'`), `the predicate must cover ${s}`)
  for (const s of ['CANCELLED', 'COMPLETED_WITH_ERRORS', 'FAILED']) {
    assert.ok(!predicate.includes(`'${s}'`), `${s} is terminal and must NOT be covered`)
  }
  // COMPLETED is a prefix of COMPLETED_WITH_ERRORS, so match the whole literal.
  assert.ok(!/'COMPLETED'/.test(predicate), 'COMPLETED is terminal and must NOT be covered')
})

test('the database refuses a second unfinished run, and allows finished ones alongside', { skip }, async () => {
  const campaignId = await makeCampaign()
  const first = await rawInsertRun(campaignId, 'PREPARING')

  await assert.rejects(
    () => rawInsertRun(campaignId, 'QUEUED'),
    (err: unknown) => /23505|unique/i.test(String((err as Error).message)),
    'a raw INSERT must be refused too — the invariant belongs to the database, not to one function'
  )

  // Finishing the first frees the slot: a campaign may be dispatched again.
  await prisma.emailCampaignRun.update({ where: { id: first }, data: { status: 'COMPLETED', completedAt: new Date() } })
  const second = await rawInsertRun(campaignId, 'QUEUED')
  assert.ok(second)

  // And any number of FINISHED runs may coexist — the whole point of PARTIAL.
  await prisma.emailCampaignRun.update({ where: { id: second }, data: { status: 'FAILED', completedAt: new Date() } })
  const a = await rawInsertRun(campaignId, 'FAILED')
  const b = await rawInsertRun(campaignId, 'CANCELLED')
  assert.ok(a && b)
  const finished = await prisma.emailCampaignRun.count({ where: { campaignId, status: { in: ['FAILED', 'CANCELLED', 'COMPLETED'] } } })
  assert.equal(finished, 4)
  assert.equal((await unfinishedRuns(campaignId)).length, 0)
})

test('a terminal run frees the slot for a genuine re-dispatch', { skip }, async () => {
  const campaignId = await makeCampaign()
  const first = await claimCampaignRunSlot(campaignId, SLOT_DATA, prisma, TX)
  assert.ok(first.claimed)
  const blocked = await claimCampaignRunSlot(campaignId, SLOT_DATA, prisma, TX)
  assert.equal(blocked.claimed, false)

  await prisma.emailCampaignRun.update({ where: { id: first.runId }, data: { status: 'FAILED', completedAt: new Date() } })
  const second = await claimCampaignRunSlot(campaignId, SLOT_DATA, prisma, TX)
  assert.ok(second.claimed, 'a FAILED preparation must not make a campaign permanently undispatchable')
  assert.notEqual(second.runId, first.runId)
})

// ── 2. The recipient claim token ────────────────────────────────────────

async function seedRecipient(status = 'PENDING'): Promise<{ campaignId: string; runId: string; recipientId: string }> {
  const campaignId = await makeCampaign()
  const run = await prisma.emailCampaignRun.create({ data: { campaignId, status: 'SENDING', snapshot: {} }, select: { id: true } })
  const recipient = await prisma.emailCampaignRecipient.create({
    data: { runId: run.id, email: EMAIL, status, batchIndex: 0 },
    select: { id: true },
  })
  return { campaignId, runId: run.id, recipientId: recipient.id }
}

test('10 concurrent claims of ONE recipient: exactly one wins and the token moves once', { skip }, async () => {
  const { recipientId } = await seedRecipient()
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      prisma.emailCampaignRecipient.updateMany({
        where: recipientClaimWhere(recipientId, 'PENDING', 0),
        data: { status: 'SENDING', attempts: { increment: 1 } },
      })
    )
  )
  const claimed = results.reduce((n, r) => n + r.count, 0)
  assert.equal(claimed, 1, `only ONE worker may claim a recipient, got ${claimed} — the others would double-send`)
  const row = await prisma.emailCampaignRecipient.findUniqueOrThrow({ where: { id: recipientId }, select: { attempts: true, status: true } })
  assert.equal(row.attempts, 1, 'the claim token must advance exactly once')
  assert.equal(row.status, 'SENDING')
})

test('a stale worker cannot overwrite the settlement of the attempt that replaced it', { skip }, async () => {
  const { runId, recipientId } = await seedRecipient()

  // Attempt 1 claims the row (token 1) and then stalls.
  const first = await prisma.emailCampaignRecipient.updateMany({
    where: recipientClaimWhere(recipientId, 'PENDING', 0),
    data: { status: 'SENDING', attempts: { increment: 1 } },
  })
  assert.equal(first.count, 1)

  // The sweep re-opens it after the stale window, exactly as sweepCampaignRuns
  // does (by updatedAt age alone — it writes no token).
  await prisma.$executeRawUnsafe(`UPDATE "email_campaign_recipients" SET "updated_at" = now() - interval '1 hour' WHERE "id" = $1`, recipientId)
  const reopened = await prisma.emailCampaignRecipient.updateMany({
    where: { runId, status: 'SENDING', updatedAt: { lt: new Date(Date.now() - 15 * 60_000) } },
    data: { status: 'PENDING', reason: 'stale_claim_reopened', nextAttemptAt: null },
  })
  assert.equal(reopened.count, 1, 'the sweep must re-open a stalled claim')

  // The stale worker returns and tries to settle with its old token.
  assert.equal(await settleRecipient(recipientId, 1, { status: 'SENT', reason: null }), false, 'a re-opened row is no longer owned by token 1')

  // Attempt 2 claims (token 2) and settles.
  const second = await prisma.emailCampaignRecipient.updateMany({
    where: recipientClaimWhere(recipientId, 'PENDING', 1),
    data: { status: 'SENDING', attempts: { increment: 1 } },
  })
  assert.equal(second.count, 1)
  assert.equal(await settleRecipient(recipientId, 2, { status: 'SKIPPED', reason: 'duplicate' }), true)

  // The worst case the old code allowed: the stale worker re-opening a row the
  // newer attempt already closed.
  assert.equal(await settleRecipient(recipientId, 1, { status: 'PENDING', reason: 'run_not_sendable' }), false)
  assert.equal(await settleRecipient(recipientId, 1, { status: 'SENT', reason: null }), false)

  const row = await prisma.emailCampaignRecipient.findUniqueOrThrow({
    where: { id: recipientId },
    select: { status: true, reason: true, attempts: true },
  })
  assert.deepEqual({ status: row.status, reason: row.reason, attempts: row.attempts }, { status: 'SKIPPED', reason: 'duplicate', attempts: 2 })
})

// ── 3. The retry re-open takes the same slot ────────────────────────────

test('re-opening a finished run is refused while another run of the campaign is unfinished, and re-opens nothing', { skip }, async () => {
  const campaignId = await makeCampaign()
  const runA = await prisma.emailCampaignRun.create({
    data: { campaignId, status: 'COMPLETED_WITH_ERRORS', snapshot: {}, completedAt: new Date() },
    select: { id: true },
  })
  const recipient = await prisma.emailCampaignRecipient.create({
    data: { runId: runA.id, email: EMAIL, status: 'FAILED', reason: 'suppression_read_failed:retries_exhausted', batchIndex: 0, attempts: 2 },
    select: { id: true, attempts: true },
  })
  const runB = await rawInsertRun(campaignId, 'QUEUED')

  // Returns before any queue work, so this needs no Redis.
  const out = await retryFailedRecipients(runA.id, SYSTEM_ACTOR)
  assert.equal(out.ok, false)
  assert.equal(out.reopened, 0)
  assert.match(String(out.error), /still in progress/i, 'the operator must be told WHY, not given a silent no-op')
  assert.ok(String(out.error).includes(runB), 'and which run is holding the slot')

  const a = await prisma.emailCampaignRun.findUniqueOrThrow({ where: { id: runA.id }, select: { status: true, completedAt: true } })
  assert.equal(a.status, 'COMPLETED_WITH_ERRORS', 'a refused retry must not leave the run half-re-opened')
  assert.notEqual(a.completedAt, null)
  const r = await prisma.emailCampaignRecipient.findUniqueOrThrow({ where: { id: recipient.id }, select: { status: true, attempts: true } })
  assert.deepEqual(r, { status: 'FAILED', attempts: 2 }, 'recipients are re-opened only AFTER the run reopen succeeds — never stranded')

  assert.equal((await unfinishedRuns(campaignId)).length, 1, 'and the invariant still holds')
})

test('nothing in this suite reached the email provider', { skip }, () => {
  assert.equal(sendSpy.mock.callCount(), 0)
})
