import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertTestRecipient, assertNoProductionCredentials } from './_disposable-test-env'

// ════════════════════════════════════════════════════════════════════════
//  guardedSend — BEHAVIOURAL tests against a fake in-memory Prisma and a
//  mocked Resend SDK. Offline: no Postgres, no Redis, no network.
//
//  The fake is installed on globalThis.prisma BEFORE email-guard (and
//  therefore db.ts) is imported, so the real guard code runs against it.
//  `updateMany` genuinely evaluates its WHERE clause — the resume/takeover
//  guarantees in the guard are conditional updates, and a fake that ignored
//  the filter would make these tests meaningless.
// ════════════════════════════════════════════════════════════════════════

assertNoProductionCredentials()

// Required for promotional compliance context (step 5b) and unsubscribe URLs.
process.env.APP_URL = 'https://app.example.com'
process.env.EMAIL_TOKEN_SECRET = 'test-secret-for-email-guard-behaviour-0123456789'
process.env.BUSINESS_POSTAL_ADDRESS = '123 Test Street, Testville, NJ 00000'
delete process.env.EMAIL_SENDING_ENABLED
delete process.env.EMAIL_PROMOTIONAL_ALLOWLIST

type Row = Record<string, any>

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key]
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>
      if ('notIn' in c && (c.notIn as unknown[]).includes(value)) return false
      if ('in' in c && !(c.in as unknown[]).includes(value)) return false
      continue
    }
    if (cond === null) {
      if (value != null) return false
      continue
    }
    if (value !== cond) return false
  }
  return true
}

const db = {
  sends: [] as Row[],
  suppressions: [] as Row[],
  failUpsert: false,
  seq: 0,
}

function applyData(row: Row, data: Record<string, unknown>) {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue
    row[k] = v
  }
  row.updatedAt = new Date()
}

const fakePrisma = {
  emailSend: {
    async create({ data }: { data: Row }) {
      if (db.sends.some((r) => r.idempotencyKey === data.idempotencyKey)) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      }
      const now = new Date()
      const row: Row = { attempts: 0, nextAttemptAt: null, ...data, id: `es_${++db.seq}`, createdAt: now, updatedAt: now }
      db.sends.push(row)
      return { ...row }
    },
    async findUnique({ where }: { where: { idempotencyKey: string } }) {
      const row = db.sends.find((r) => r.idempotencyKey === where.idempotencyKey)
      return row ? { ...row } : null
    },
    async update({ where, data }: { where: { id: string }; data: Row }) {
      const row = db.sends.find((r) => r.id === where.id)
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' })
      applyData(row, data)
      return { ...row }
    },
    async updateMany({ where, data }: { where: Row; data: Row }) {
      const hits = db.sends.filter((r) => matches(r, where))
      for (const r of hits) applyData(r, data)
      return { count: hits.length }
    },
    async upsert({ where, create, update }: { where: { idempotencyKey: string }; create: Row; update: Row }) {
      if (db.failUpsert) throw new Error('simulated DB outage on upsert')
      const existing = db.sends.find((r) => r.idempotencyKey === where.idempotencyKey)
      if (existing) {
        applyData(existing, update)
        return { ...existing }
      }
      return fakePrisma.emailSend.create({ data: create })
    },
    async count() {
      return 0
    },
  },
  emailSuppression: {
    async findUnique({ where }: { where: { email: string } }) {
      const row = db.suppressions.find((r) => r.email === where.email)
      return row ? { ...row } : null
    },
  },
}

;(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma

function resetDb() {
  db.sends.length = 0
  db.suppressions.length = 0
  db.failUpsert = false
}

const load = async () => {
  const guard = await import('../email-guard')
  const { resend } = await import('../resend')
  return { ...guard, resend }
}

let eventSeq = 0
function input(to: string, template = 'quote-request-received', extra: Record<string, unknown> = {}) {
  assertTestRecipient(to)
  return {
    to,
    subject: 'Test subject',
    html: '<p>test</p>',
    template,
    eventId: `evt_${++eventSeq}`,
    ...extra,
  }
}

const ok = async () => ({ data: { id: 'prov_1' }, error: null })

// ── 1 ────────────────────────────────────────────────────────────────────
test('numberFromEnv: blank/invalid falls back, real non-negative numbers override; CAPS.perDay blank → 1', async () => {
  const { numberFromEnv, CAPS } = await load()
  for (const raw of [undefined, '', '  ', 'abc', '-1']) {
    assert.equal(numberFromEnv(raw, 7), 7, `raw=${JSON.stringify(raw)} should fall back`)
  }
  assert.equal(numberFromEnv('0', 7), 0)
  assert.equal(numberFromEnv('3', 7), 3)

  const saved = process.env.EMAIL_CAP_PER_DAY
  try {
    process.env.EMAIL_CAP_PER_DAY = ''
    assert.equal(CAPS.perDay, 1)
    process.env.EMAIL_CAP_PER_DAY = '4'
    assert.equal(CAPS.perDay, 4)
  } finally {
    if (saved === undefined) delete process.env.EMAIL_CAP_PER_DAY
    else process.env.EMAIL_CAP_PER_DAY = saved
  }
})

// ── 2 ────────────────────────────────────────────────────────────────────
test('isAmbiguousProviderError: only a provider-issued 4xx (not 408) is a definitive rejection', async () => {
  const { isAmbiguousProviderError } = await load()
  const ambiguous: unknown[] = [
    { name: 'application_error', message: 'Unable to fetch data' },
    { statusCode: 500, name: 'internal_server_error' },
    { statusCode: 502 },
    { statusCode: 408 },
    null,
    {},
    'x',
  ]
  for (const e of ambiguous) assert.equal(isAmbiguousProviderError(e), true, `${JSON.stringify(e)} should be ambiguous`)
  const definitive: unknown[] = [
    { statusCode: 422, name: 'validation_error' },
    { statusCode: 429, name: 'rate_limit_exceeded' },
    { name: 'invalid_api_Key' },
    { statusCode: '403' },
  ]
  for (const e of definitive) assert.equal(isAmbiguousProviderError(e), false, `${JSON.stringify(e)} should be definitive`)
})

// ── 3 ────────────────────────────────────────────────────────────────────
test('application_error from Resend → ambiguous, no throw, and never auto-resent on a second call', async (t) => {
  resetDb()
  const { guardedSend, resend } = await load()
  const send = t.mock.method(resend.emails, 'send', async () => ({
    data: null,
    error: { name: 'application_error', message: 'Unable to fetch data. The request could not be resolved.' },
  }))
  const inp = input('ambiguous@example.com')

  const first = await guardedSend(inp)
  assert.equal(first.sent, false)
  assert.equal((first as any).reason, 'ambiguous')
  assert.equal((first as any).outcomeClass, 'ambiguous')
  assert.equal(send.mock.callCount(), 1)
  assert.equal(db.sends.length, 1)
  assert.equal(db.sends[0].status, 'ambiguous')

  const second = await guardedSend(inp)
  assert.equal(second.sent, false)
  assert.equal((second as any).reason, 'terminal:ambiguous')
  assert.equal(send.mock.callCount(), 1, 'an ambiguous send must never be auto-resent')
})

// ── 4 ────────────────────────────────────────────────────────────────────
test('success response with no provider id → ambiguous, never delivered', async (t) => {
  resetDb()
  const { guardedSend, resend } = await load()
  const send = t.mock.method(resend.emails, 'send', async () => ({ data: {}, error: null }))

  const out = await guardedSend(input('noid@example.com'))
  assert.equal(out.sent, false)
  assert.equal((out as any).reason, 'ambiguous')
  assert.equal(send.mock.callCount(), 1)
  assert.equal(db.sends[0].status, 'ambiguous')
  assert.notEqual(db.sends[0].status, 'delivered')
  assert.equal(db.sends[0].providerId, undefined)
})

// ── 5 ────────────────────────────────────────────────────────────────────
test('definitive 422 → throws, provider_rejected with backoff, not_due until then, resumes to attempt 2', async (t) => {
  resetDb()
  const { guardedSend, resend } = await load()
  let reject = true
  const send = t.mock.method(resend.emails, 'send', async () =>
    reject
      ? { data: null, error: { name: 'validation_error', message: 'Invalid `to` field', statusCode: 422 } }
      : { data: { id: 'prov_retry' }, error: null }
  )
  const inp = input('rejected@example.com')

  const before = Date.now()
  const { ProviderRejectedError } = await load()
  let thrown: unknown
  await assert.rejects(async () => {
    try {
      await guardedSend(inp)
    } catch (err) {
      thrown = err
      throw err
    }
  }, /Resend error/)
  assert.equal(send.mock.callCount(), 1)
  const row = db.sends[0]
  assert.equal(row.status, 'provider_rejected')
  assert.ok(row.nextAttemptAt instanceof Date)
  const delta = row.nextAttemptAt.getTime() - before
  assert.ok(delta >= 59_000 && delta <= 62_000, `nextAttemptAt should be ≈ now+60s (got +${delta}ms)`)
  // The error carries the due time, so a worker on its LAST queue attempt can re-queue.
  assert.ok(thrown instanceof ProviderRejectedError)
  assert.ok(Math.abs((thrown as InstanceType<typeof ProviderRejectedError>).retryAt!.getTime() - row.nextAttemptAt.getTime()) < 1_000)

  const notDue = await guardedSend(inp)
  assert.equal(notDue.sent, false)
  assert.equal((notDue as any).reason, 'not_due')
  assert.equal((notDue as any).notDueUntil.getTime(), row.nextAttemptAt.getTime())
  assert.equal((notDue as any).retryAt, undefined, 'not_due must not set retryAt')
  assert.equal(send.mock.callCount(), 1, 'a not-due send must not reach the provider')

  row.nextAttemptAt = new Date(Date.now() - 1_000)
  reject = false
  const retried = await guardedSend(inp)
  assert.equal(retried.sent, true)
  assert.equal((retried as any).providerId, 'prov_retry')
  assert.equal(row.attempts, 2)
  assert.equal(row.status, 'delivered')
  assert.equal(send.mock.callCount(), 2)
})

// ── 6 ────────────────────────────────────────────────────────────────────
test('two concurrent identical sends → exactly one provider call', async (t) => {
  resetDb()
  const { guardedSend, resend } = await load()
  const send = t.mock.method(resend.emails, 'send', () =>
    new Promise((r) => setTimeout(() => r({ data: { id: 'prov_once' }, error: null }), 20))
  )
  const inp = input('concurrent@example.com')

  const outs = await Promise.all([guardedSend(inp), guardedSend(inp)])
  assert.equal(send.mock.callCount(), 1)
  const sent = outs.filter((o) => o.sent)
  const other = outs.filter((o) => !o.sent)
  assert.equal(sent.length, 1)
  assert.equal(other.length, 1)
  assert.ok(['in_flight', 'duplicate'].includes((other[0] as any).reason), `got ${(other[0] as any).reason}`)
})

// ── 6b ───────────────────────────────────────────────────────────────────
test('a STALE sending claim (worker died mid-send) → ambiguous, never taken over and re-sent', async (t) => {
  resetDb()
  const { guardedSend, resend, SENDING_STALE_MS } = await load()
  const send = t.mock.method(resend.emails, 'send', ok)
  const inp = input('stale-claim@example.com')

  // Seed exactly what a crash after the provider call leaves behind.
  await guardedSend(inp)
  assert.equal(send.mock.callCount(), 1)
  const row = db.sends[0]
  row.status = 'sending'
  row.providerId = undefined
  const staleAt = new Date(Date.now() - SENDING_STALE_MS - 60_000)
  row.updatedAt = staleAt

  const out = await guardedSend(inp)
  assert.equal(out.sent, false)
  assert.equal((out as any).reason, 'ambiguous')
  assert.equal((out as any).outcomeClass, 'ambiguous')
  assert.equal(row.status, 'ambiguous')
  assert.equal(send.mock.callCount(), 1, 'the provider may already have accepted it: no second call')

  const again = await guardedSend(inp)
  assert.equal((again as any).reason, 'terminal:ambiguous')
  assert.equal(send.mock.callCount(), 1)
})

test('a policy refusal never turns a stale sending claim resumable (kill switch on, then off → ambiguous, no re-send)', async (t) => {
  resetDb()
  const { guardedSend, resend, SENDING_STALE_MS } = await load()
  const send = t.mock.method(resend.emails, 'send', ok)
  const inp = input('killswitch-stale@example.com')
  await guardedSend(inp)
  const row = db.sends[0]
  row.status = 'sending'
  row.updatedAt = new Date(Date.now() - SENDING_STALE_MS - 60_000)

  process.env.EMAIL_SENDING_ENABLED = 'false'
  try {
    const held = await guardedSend(inp)
    assert.equal((held as any).reason, 'email_sending_disabled')
    assert.equal(row.status, 'sending', 'recordBlock must not rewrite a sending row into a resumable one')
  } finally {
    delete process.env.EMAIL_SENDING_ENABLED
  }
  row.updatedAt = new Date(Date.now() - SENDING_STALE_MS - 60_000)
  const after = await guardedSend(inp)
  assert.equal((after as any).reason, 'ambiguous')
  assert.equal(row.status, 'ambiguous')
  assert.equal(send.mock.callCount(), 1, 'no second provider call')
})

test('a stale sending claim at MAX attempts is ambiguous, not "attempts exhausted"', async (t) => {
  resetDb()
  const { guardedSend, resend, SENDING_STALE_MS, MAX_SEND_ATTEMPTS } = await load()
  const send = t.mock.method(resend.emails, 'send', ok)
  const inp = input('stale-max@example.com')
  await guardedSend(inp)
  const row = db.sends[0]
  row.status = 'sending'
  row.attempts = MAX_SEND_ATTEMPTS
  row.updatedAt = new Date(Date.now() - SENDING_STALE_MS - 60_000)
  const out = await guardedSend(inp)
  assert.equal((out as any).reason, 'ambiguous')
  assert.equal(row.status, 'ambiguous')
  assert.equal(send.mock.callCount(), 1)
})

test('the stale close reports the row as it is when the late worker finished first (no false ambiguous)', async (t) => {
  resetDb()
  const { guardedSend, resend, SENDING_STALE_MS } = await load()
  t.mock.method(resend.emails, 'send', ok)
  const inp = input('late-finish@example.com')
  await guardedSend(inp)
  const row = db.sends[0]
  row.status = 'sending'
  row.updatedAt = new Date(Date.now() - SENDING_STALE_MS - 60_000)
  // The late worker writes 'delivered' between the read and the conditional close.
  const original = fakePrisma.emailSend.updateMany
  fakePrisma.emailSend.updateMany = async (args: any) => {
    if (args?.data?.status === 'ambiguous') {
      row.status = 'delivered'
      row.updatedAt = new Date()
    }
    return original(args)
  }
  try {
    const out = await guardedSend(inp)
    assert.equal((out as any).reason, 'duplicate')
    assert.equal(row.status, 'delivered')
  } finally {
    fakePrisma.emailSend.updateMany = original
  }
})

test('reopenForRetry refuses a sending row (live, or dead mid-send)', async (t) => {
  resetDb()
  const { guardedSend, resend, reopenForRetry } = await load()
  t.mock.method(resend.emails, 'send', ok)
  const inp = input('reopen-sending@example.com')
  await guardedSend(inp)
  const row = db.sends[0]
  row.status = 'sending'
  assert.equal(await reopenForRetry(row.idempotencyKey), 'refused_in_flight')
  assert.equal(row.status, 'sending')
  row.status = 'ambiguous'
  assert.equal(await reopenForRetry(row.idempotencyKey), 'reopened', 'an ambiguous row is reopened deliberately by a human')
})

test('a FRESH sending claim → in_flight, untouched', async (t) => {
  resetDb()
  const { guardedSend, resend } = await load()
  const send = t.mock.method(resend.emails, 'send', ok)
  const inp = input('live-claim@example.com')
  await guardedSend(inp)
  const row = db.sends[0]
  row.status = 'sending'
  row.updatedAt = new Date()
  const out = await guardedSend(inp)
  assert.equal((out as any).reason, 'in_flight')
  assert.equal(row.status, 'sending')
  assert.equal(send.mock.callCount(), 1)
})

// ── 7 ────────────────────────────────────────────────────────────────────
test('hard-bounce suppression (scope all) refuses before the provider, recorded blocked_terminal', async (t) => {
  resetDb()
  const { guardedSend, resend } = await load()
  const send = t.mock.method(resend.emails, 'send', ok)
  const to = 'bounced@example.com'
  db.suppressions.push({ email: to, reason: 'HARD_BOUNCE', scope: 'all' })

  const out = await guardedSend(input(to))
  assert.equal(out.sent, false)
  assert.equal((out as any).reason, 'hard_bounce')
  assert.equal((out as any).outcomeClass, 'terminal')
  assert.equal(send.mock.callCount(), 0)
  assert.equal(db.sends.length, 1)
  assert.equal(db.sends[0].status, 'blocked_terminal')
})

test('unsubscribe (scope promotional) blocks a promotional template but not a transactional one', async (t) => {
  resetDb()
  const { guardedSend, resend } = await load()
  const send = t.mock.method(resend.emails, 'send', ok)
  const to = 'unsub@example.com'
  db.suppressions.push({ email: to, reason: 'UNSUBSCRIBED', scope: 'promotional' })

  const promo = await guardedSend(input(to, 'quote-followup-1'))
  assert.equal(promo.sent, false)
  assert.equal((promo as any).reason, 'unsubscribed')
  assert.equal(send.mock.callCount(), 0)

  const txn = await guardedSend(input(to, 'quote-request-received'))
  assert.equal(txn.sent, true, `transactional send should pass, got ${JSON.stringify(txn)}`)
  assert.equal(send.mock.callCount(), 1)
})

// ── 8 ────────────────────────────────────────────────────────────────────
test('recordBlock DB failure → recorded:false and blockRecordFailureStats increments', async (t) => {
  resetDb()
  const { guardedSend, resend, blockRecordFailureStats } = await load()
  const send = t.mock.method(resend.emails, 'send', ok)
  const to = 'outage@example.com'
  db.suppressions.push({ email: to, reason: 'HARD_BOUNCE', scope: 'all' })
  db.failUpsert = true

  const before = blockRecordFailureStats().count
  const out = await guardedSend(input(to))
  assert.equal(out.sent, false)
  assert.equal((out as any).recorded, false)
  assert.equal(blockRecordFailureStats().count, before + 1)
  assert.equal(blockRecordFailureStats().lastReason, 'hard_bounce')
  assert.equal(send.mock.callCount(), 0)
})

// ── 9 ────────────────────────────────────────────────────────────────────
test('quiet hours, caps and transactional gap are enforced only inside the promotional block', () => {
  const src = readFileSync(resolve(__dirname, '../email-guard.ts'), 'utf8')
  const fnStart = src.indexOf('export async function guardedSend(')
  const fnEnd = src.indexOf('export function isAmbiguousProviderError(')
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'guardedSend body must be locatable')
  const body = src.slice(fnStart, fnEnd)

  const marker = "if (emailClass === 'promotional') {"
  const blockStart = body.indexOf(marker)
  assert.ok(blockStart > -1, 'guardedSend must have a promotional-only block')
  let depth = 0
  let blockEnd = -1
  for (let i = blockStart + marker.length - 1; i < body.length; i++) {
    if (body[i] === '{') depth++
    else if (body[i] === '}') {
      depth--
      if (depth === 0) {
        blockEnd = i
        break
      }
    }
  }
  assert.ok(blockEnd > blockStart, 'promotional block must close')

  for (const needle of ['inQuietHours(', "'quiet_hours'", "'cap_daily'", "'transactional_gap'"]) {
    let idx = body.indexOf(needle)
    assert.ok(idx > -1, `${needle} must appear in guardedSend`)
    while (idx > -1) {
      assert.ok(idx > blockStart && idx < blockEnd, `${needle} at offset ${idx} is outside the promotional block`)
      idx = body.indexOf(needle, idx + 1)
    }
  }
  assert.ok(/refuse\('quiet_hours'/.test(body.slice(blockStart, blockEnd)))
  assert.ok(/refuse\('transactional_gap'/.test(body.slice(blockStart, blockEnd)))
})
