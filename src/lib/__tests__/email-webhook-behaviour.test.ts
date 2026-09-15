// ════════════════════════════════════════════════════════════════════════
//  EMAIL WEBHOOK — BEHAVIOUR against a fake database (2026-09-15 fix).
//  ---------------------------------------------------------------------
//  email-events.test.ts proves the signature maths and pins wiring by reading
//  source. This suite RUNS the real webhook core end to end — verify, parse,
//  record, apply delivery state, suppress — against an in-memory Prisma that
//  honours the conditions the production guarantees depend on:
//    • emailEvent.create throws P2002 on a duplicate providerEventId
//    • emailSend.updateMany honours `{ id, [column]: null }` (first writer wins)
//    • emailSuppression.upsert can be made to fail on demand
//  No Postgres, no Redis, no network. Every recipient is @example.com.
// ════════════════════════════════════════════════════════════════════════

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { assertTestRecipient, assertNoProductionCredentials } from './_disposable-test-env'

assertNoProductionCredentials()

// ── Secrets BEFORE any import of the code under test ────────────────────
const SECRET_RAW = crypto.randomBytes(32).toString('base64')
process.env.RESEND_WEBHOOK_SECRET = `whsec_${SECRET_RAW}`
const SUPPRESSION_KEY = crypto.randomBytes(16).toString('hex')
process.env.EMAIL_SUPPRESSION_API_KEY = SUPPRESSION_KEY

// ── Fake Prisma ─────────────────────────────────────────────────────────
type Row = Record<string, any>

const db = {
  sends: [] as Row[],
  events: [] as Row[],
  suppressions: [] as Row[],
  enrollmentStops: 0,
  /** When set, emailSuppression.upsert throws this. */
  upsertFault: null as Error | null,
  upsertCalls: 0,
  queryRawRows: [] as Row[],
}

let seq = 0
const nextId = (p: string) => `${p}_${++seq}`
/** Yield to the event loop so concurrent callers genuinely interleave. */
const tick = () => new Promise<void>((r) => setImmediate(r))

function matches(row: Row, where: Row): boolean {
  for (const [k, cond] of Object.entries(where)) {
    if (cond === null) {
      if (row[k] != null) return false
    } else if (typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond && !(cond.in as unknown[]).includes(row[k])) return false
    } else if (row[k] !== cond) return false
  }
  return true
}

function pick(row: Row | undefined, select?: Row): Row | null {
  if (!row) return null
  if (!select) return { ...row }
  const out: Row = {}
  for (const k of Object.keys(select)) out[k] = row[k]
  return out
}

const fakePrisma = {
  emailSend: {
    async findFirst({ where, select }: Row) {
      await tick()
      return pick(db.sends.find((s) => matches(s, where)), select)
    },
    async updateMany({ where, data }: Row) {
      await tick()
      let count = 0
      for (const s of db.sends) {
        if (matches(s, where)) {
          Object.assign(s, data)
          count++
        }
      }
      return { count }
    },
  },
  emailEvent: {
    async create({ data, select }: Row) {
      await tick()
      if (db.events.some((e) => e.providerEventId === data.providerEventId)) {
        throw Object.assign(new Error('Unique constraint failed on providerEventId'), { code: 'P2002' })
      }
      const row = { id: nextId('evt'), sideEffectAttempts: 0, sideEffectError: null, ...data }
      db.events.push(row)
      return pick(row, select)
    },
    async findUnique({ where, select }: Row) {
      await tick()
      return pick(db.events.find((e) => matches(e, where)), select)
    },
    async update({ where, data }: Row) {
      await tick()
      const row = db.events.find((e) => e.id === where.id)
      if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' })
      Object.assign(row, data)
      return { ...row }
    },
    async findMany() {
      return []
    },
  },
  emailSuppression: {
    async findUnique({ where, select }: Row) {
      await tick()
      return pick(db.suppressions.find((s) => s.email === where.email), select)
    },
    async upsert({ where, create, update }: Row) {
      db.upsertCalls++
      await tick()
      if (db.upsertFault) throw db.upsertFault
      const existing = db.suppressions.find((s) => s.email === where.email)
      if (existing) {
        for (const [k, v] of Object.entries(update)) if (v !== undefined) existing[k] = v
        return { ...existing }
      }
      const row = { id: nextId('sup'), createdAt: new Date(), ...create }
      db.suppressions.push(row)
      return { ...row }
    },
    async create({ data }: Row) {
      await tick()
      if (db.suppressions.some((s) => s.email === data.email)) {
        throw Object.assign(new Error('dup'), { code: 'P2002' })
      }
      const row = { id: nextId('sup'), createdAt: new Date(), ...data }
      db.suppressions.push(row)
      return row
    },
  },
  emailAutomationEnrollment: {
    async updateMany() {
      db.enrollmentStops++
      return { count: 0 }
    },
  },
  customer: {
    async updateMany() {
      return { count: 0 }
    },
  },
  async $queryRaw(..._args: unknown[]) {
    return db.queryRawRows
  },
}
;(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma

beforeEach(() => {
  db.sends = []
  db.events = []
  db.suppressions = []
  db.enrollmentStops = 0
  db.upsertFault = null
  db.upsertCalls = 0
  db.queryRawRows = []
})

// ── Helpers ─────────────────────────────────────────────────────────────
const load = () => import('../email-events')

function sign(raw: string, id: string, ts: number): string {
  return crypto.createHmac('sha256', Buffer.from(SECRET_RAW, 'base64')).update(`${id}.${ts}.${raw}`).digest('base64')
}

function headersFor(raw: string, id = `msg_${crypto.randomUUID()}`, ts = Math.floor(Date.now() / 1000)) {
  return { id, timestamp: String(ts), signature: `v1,${sign(raw, id, ts)}` }
}

const RECIPIENT = 'Customer.One@Example.com'
const NORMALIZED = 'customer.one@example.com'
assertTestRecipient(RECIPIENT)

function seedSend(providerId = 'prov_1'): Row {
  const row = { id: nextId('send'), providerId, email: NORMALIZED, deliveredAt: null, bouncedAt: null, complainedAt: null, deliveryDetail: null }
  db.sends.push(row)
  return row
}

function eventBody(type: string, extra: Row = {}, providerId = 'prov_1'): string {
  return JSON.stringify({
    type,
    created_at: '2026-09-15T12:00:00.000Z',
    data: { email_id: providerId, to: [RECIPIENT], ...extra },
  })
}

// Let fire-and-forget work (stopEnrollmentsFor dynamic import) settle.
const settle = () => new Promise<void>((r) => setTimeout(r, 20))

// ════════════════════════════════════════════════════════════════════════
//  1–3. Verification
// ════════════════════════════════════════════════════════════════════════

test('1. forged signature is rejected with 400 and writes nothing', async () => {
  const { processEmailWebhook } = await load()
  seedSend()
  const raw = eventBody('email.complained')
  const h = headersFor(raw)
  const forged = { ...h, signature: `v1,${crypto.randomBytes(32).toString('base64')}` }
  const res = await processEmailWebhook(raw, forged)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, 'invalid_signature')
  assert.equal(db.events.length, 0)
  assert.equal(db.suppressions.length, 0)
  assert.equal(db.upsertCalls, 0)
})

test('2. correctly signed but 10 minutes old or 10 minutes in the future is rejected', async () => {
  const { processEmailWebhook } = await load()
  const raw = eventBody('email.bounced', { bounce: { type: 'Permanent', subType: 'General' } })
  const now = Math.floor(Date.now() / 1000)
  const old = await processEmailWebhook(raw, headersFor(raw, 'msg_old', now - 600))
  const future = await processEmailWebhook(raw, headersFor(raw, 'msg_future', now + 600))
  assert.equal(old.status, 400)
  assert.equal(future.status, 400)
  assert.equal(db.events.length, 0)
  assert.equal(db.suppressions.length, 0)
})

test('3. verification is over the RAW body: whitespace accepted, re-serialized body rejected', async () => {
  const { processEmailWebhook } = await load()
  const raw = `{\n  "type" : "email.delivered",\n  "created_at": "2026-09-15T12:00:00.000Z",\n  "data": { "email_id": "prov_1", "to": ["${RECIPIENT}"] }\n}\n`
  const h = headersFor(raw)
  const reserialized = JSON.stringify(JSON.parse(raw))
  assert.notEqual(reserialized, raw)
  const rejected = await processEmailWebhook(reserialized, h)
  assert.equal(rejected.status, 400)
  assert.equal(db.events.length, 0)
  const accepted = await processEmailWebhook(raw, h)
  assert.equal(accepted.status, 200)
  assert.equal(db.events.length, 1)
})

// ════════════════════════════════════════════════════════════════════════
//  4. Idempotency
// ════════════════════════════════════════════════════════════════════════

test('4a. same svix-id delivered twice sequentially: one event row, one suppression, both 200', async () => {
  const { processEmailWebhook } = await load()
  seedSend()
  const raw = eventBody('email.bounced', { bounce: { type: 'Permanent', subType: 'General' } })
  const h = headersFor(raw)
  const a = await processEmailWebhook(raw, h)
  const b = await processEmailWebhook(raw, h)
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  assert.equal(b.body.result, 'duplicate')
  assert.equal(db.events.length, 1)
  assert.ok(db.suppressions.length <= 1)
  assert.equal(db.suppressions.length, 1)
  await settle()
})

test('4b. same svix-id delivered twice concurrently: one event row, at most one suppression, both 200', async () => {
  const { processEmailWebhook } = await load()
  seedSend()
  const raw = eventBody('email.complained')
  const h = headersFor(raw)
  const [a, b] = await Promise.all([processEmailWebhook(raw, h), processEmailWebhook(raw, h)])
  assert.equal(a.status, 200, JSON.stringify(a.body))
  assert.equal(b.status, 200, JSON.stringify(b.body))
  assert.equal(db.events.length, 1)
  assert.equal(db.suppressions.length, 1)
  assert.equal(db.events[0].processingStatus, 'processed')
  await settle()
})

// ════════════════════════════════════════════════════════════════════════
//  5–8. Event semantics
// ════════════════════════════════════════════════════════════════════════

test('5. hard bounce: HARD_BOUNCE scope all, bouncedAt set, event type bounced', async () => {
  const { processEmailWebhook } = await load()
  const send = seedSend()
  const raw = eventBody('email.bounced', { bounce: { type: 'Permanent', subType: 'General' } })
  const res = await processEmailWebhook(raw, headersFor(raw))
  assert.equal(res.status, 200)
  assert.equal(res.body.result, 'suppressed:HARD_BOUNCE')
  assert.equal(db.suppressions.length, 1)
  assert.equal(db.suppressions[0].email, NORMALIZED)
  assert.equal(db.suppressions[0].reason, 'HARD_BOUNCE')
  assert.equal(db.suppressions[0].scope, 'all')
  assert.ok(send.bouncedAt instanceof Date)
  assert.equal(send.bouncedAt.toISOString(), '2026-09-15T12:00:00.000Z')
  assert.equal(db.events.length, 1)
  assert.equal(db.events[0].type, 'bounced')
  assert.equal(db.events[0].emailSendId, send.id)
  assert.equal(db.events[0].processingStatus, 'processed')
  await settle()
})

test('6. soft bounce: soft_bounce result, no suppression, bouncedAt null, event soft_bounced', async () => {
  const { processEmailWebhook } = await load()
  const send = seedSend()
  const raw = eventBody('email.bounced', {
    bounce: { type: 'Transient', subType: 'General', message: '550 4.4.7 Message expired' },
  })
  const res = await processEmailWebhook(raw, headersFor(raw))
  assert.equal(res.status, 200)
  assert.equal(res.body.result, 'soft_bounce')
  assert.equal(db.suppressions.length, 0)
  assert.equal(db.upsertCalls, 0)
  assert.equal(send.bouncedAt, null)
  assert.equal(db.events.length, 1)
  assert.equal(db.events[0].type, 'soft_bounced')
  assert.equal(db.events[0].processingStatus, 'processed')
})

test('7a. complaint: SPAM_COMPLAINT scope all, complainedAt set', async () => {
  const { processEmailWebhook } = await load()
  const send = seedSend()
  const raw = eventBody('email.complained')
  const res = await processEmailWebhook(raw, headersFor(raw))
  assert.equal(res.status, 200)
  assert.equal(db.suppressions[0].reason, 'SPAM_COMPLAINT')
  assert.equal(db.suppressions[0].scope, 'all')
  assert.ok(send.complainedAt instanceof Date)
  assert.equal(db.events[0].type, 'complained')
  await settle()
})

test('7b. email.suppressed: PROVIDER_REJECTED scope all', async () => {
  const { processEmailWebhook } = await load()
  seedSend()
  const raw = eventBody('email.suppressed')
  const res = await processEmailWebhook(raw, headersFor(raw))
  assert.equal(res.status, 200)
  assert.equal(db.suppressions.length, 1)
  assert.equal(db.suppressions[0].reason, 'PROVIDER_REJECTED')
  assert.equal(db.suppressions[0].scope, 'all')
  assert.equal(db.events[0].type, 'provider_suppressed')
  await settle()
})

test('8a. delivered after bounced: bouncedAt unchanged, deliveredAt set', async () => {
  const { processEmailWebhook } = await load()
  const send = seedSend()
  const bounced = eventBody('email.bounced', { bounce: { type: 'Permanent', subType: 'General' } })
  await processEmailWebhook(bounced, headersFor(bounced))
  const bouncedAt = send.bouncedAt
  assert.ok(bouncedAt instanceof Date)
  const delivered = JSON.stringify({
    type: 'email.delivered',
    created_at: '2026-09-15T12:05:00.000Z',
    data: { email_id: 'prov_1', to: [RECIPIENT] },
  })
  const res = await processEmailWebhook(delivered, headersFor(delivered))
  assert.equal(res.status, 200)
  assert.equal(send.bouncedAt, bouncedAt)
  assert.ok(send.deliveredAt instanceof Date)
  assert.equal(send.deliveredAt.toISOString(), '2026-09-15T12:05:00.000Z')
  // A second, later bounce cannot move the first bounce timestamp either.
  const later = JSON.stringify({
    type: 'email.bounced',
    created_at: '2026-09-15T13:00:00.000Z',
    data: { email_id: 'prov_1', to: [RECIPIENT], bounce: { type: 'Permanent', subType: 'General' } },
  })
  await processEmailWebhook(later, headersFor(later))
  assert.equal(send.bouncedAt.toISOString(), '2026-09-15T12:00:00.000Z')
  await settle()
})

test('8b. delivery_delayed and failed: recorded, no delivery column, no suppression', async () => {
  const { processEmailWebhook } = await load()
  const send = seedSend()
  for (const type of ['email.delivery_delayed', 'email.failed']) {
    const raw = eventBody(type)
    const res = await processEmailWebhook(raw, headersFor(raw))
    assert.equal(res.status, 200)
    assert.equal(res.body.result, 'recorded')
  }
  assert.deepEqual(db.events.map((e) => e.type), ['delivery_delayed', 'failed'])
  assert.equal(send.deliveredAt, null)
  assert.equal(send.bouncedAt, null)
  assert.equal(send.complainedAt, null)
  assert.equal(db.suppressions.length, 0)
  assert.equal(db.upsertCalls, 0)
})

// ════════════════════════════════════════════════════════════════════════
//  9. Suppression write failure is retriable, and a replay heals it
// ════════════════════════════════════════════════════════════════════════

test('9. suppression upsert throws → 500 retry + side_effect_failed; replay after fault clears → 200, suppressed', async () => {
  const { processEmailWebhook } = await load()
  seedSend()
  const raw = eventBody('email.bounced', { bounce: { type: 'Permanent', subType: 'General' } })
  const h = headersFor(raw)

  db.upsertFault = new Error('connection terminated unexpectedly')
  const first = await processEmailWebhook(raw, h)
  assert.equal(first.status, 500)
  assert.equal(first.body.ok, false)
  assert.equal(first.body.retry, true)
  assert.equal(db.events.length, 1)
  assert.equal(db.events[0].processingStatus, 'side_effect_failed')
  assert.equal(db.events[0].sideEffectAttempts, 1)
  assert.match(String(db.events[0].sideEffectError), /connection terminated/)
  assert.equal(db.suppressions.length, 0)

  db.upsertFault = null
  const replay = await processEmailWebhook(raw, h)
  assert.equal(replay.status, 200, JSON.stringify(replay.body))
  assert.equal(replay.body.result, 'suppressed:HARD_BOUNCE')
  assert.equal(db.events.length, 1)
  assert.equal(db.events[0].processingStatus, 'processed')
  assert.equal(db.events[0].sideEffectAttempts, 2)
  assert.equal(db.suppressions.length, 1)
  assert.equal(db.suppressions[0].reason, 'HARD_BOUNCE')
  await settle()
})

// ════════════════════════════════════════════════════════════════════════
//  10. Pure bounce classification
// ════════════════════════════════════════════════════════════════════════

test('10a. isHardBounce table', async () => {
  const { isHardBounce } = await import('../bounce-classification')
  const table: Array<[Parameters<typeof isHardBounce>[0], boolean]> = [
    [{ type: 'Permanent', subType: 'General' }, true],
    [{ type: 'Transient', subType: 'General' }, false],
    [{ type: 'Undetermined', subType: 'General' }, false],
    [{ subType: 'NoSuchUser' }, true],
    [{ subType: 'General' }, true],
    [{ type: 'Permanent', subType: 'MailboxFull' }, false],
    [undefined, false],
  ]
  for (const [input, expected] of table) {
    assert.equal(isHardBounce(input), expected, JSON.stringify(input))
  }
})

test('10b. bounceFromEventDetail: parsed, truncated, and absent', async () => {
  const { bounceFromEventDetail } = await import('../bounce-classification')
  const data = {
    email_id: 'prov_1',
    to: [NORMALIZED],
    bounce: { type: 'Transient', subType: 'General', message: '550 4.4.7 Message expired' },
    headers: Array.from({ length: 60 }, (_, i) => ({ name: `X-Header-${i}`, value: 'v'.repeat(20) })),
  }
  const full = JSON.stringify(data)
  assert.deepEqual(bounceFromEventDetail(full), data.bounce)

  assert.ok(full.length > 1000)
  const truncated = full.slice(0, 1000) // exactly what handleEmailEvent stores
  assert.throws(() => JSON.parse(truncated))
  assert.ok(truncated.includes('"bounce"'))
  const recovered = bounceFromEventDetail(truncated)
  assert.equal(recovered?.type, 'Transient')
  assert.equal(recovered?.subType, 'General')

  assert.equal(bounceFromEventDetail(JSON.stringify({ email_id: 'prov_1', to: [NORMALIZED] })), undefined)
  assert.equal(bounceFromEventDetail(null), undefined)
  assert.equal(bounceFromEventDetail('{"email_id":"prov_1","to":["a@exa'), undefined)
})

// ════════════════════════════════════════════════════════════════════════
//  11. Consent health check ignores soft bounces
// ════════════════════════════════════════════════════════════════════════

async function runEventNotApplied() {
  const { consentChecks } = await import('../email-agent/checks/consent')
  const { envDefaults } = await import('../email-agent/settings')
  const check = consentChecks.find((c) => c.id === 'suppression.event_not_applied')
  assert.ok(check, 'suppression.event_not_applied check must exist')
  const ctx = { now: new Date('2026-09-15T12:00:00Z'), settings: envDefaults({} as NodeJS.ProcessEnv), windowHours: 24, inspected: {}, dryRun: true }
  return check.run(ctx)
}

const auditRow = (type: string, detail: Row | null) => ({
  id: nextId('evt'),
  email: NORMALIZED,
  type,
  occurred_at: new Date('2026-09-15T11:00:00Z'),
  processing_status: 'processed',
  email_send_id: null,
  detail: detail ? JSON.stringify(detail) : null,
})

test('11a. consent check: a soft-bounce "bounced" row with no suppression is NOT a finding', async () => {
  db.queryRawRows = [auditRow('bounced', { to: [NORMALIZED], bounce: { type: 'Transient', subType: 'General', message: '550 4.4.7 Message expired' } })]
  const findings = await runEventNotApplied()
  assert.equal(findings.length, 0)
})

test('11b. consent check: a Permanent "bounced" row with no suppression is one finding', async () => {
  db.queryRawRows = [auditRow('bounced', { to: [NORMALIZED], bounce: { type: 'Permanent', subType: 'General' } })]
  const findings = await runEventNotApplied()
  assert.equal(findings.length, 1)
  assert.equal(findings[0].checkId, 'suppression.event_not_applied')
  assert.equal(findings[0].severity, 'warning')
  assert.equal((findings[0].evidence as Row).total, 1)
})

test('11b2. consent check: a "bounced" row whose TRUNCATED detail cannot be classified stays visible', async () => {
  const long = JSON.stringify({ to: [NORMALIZED], subject: 'x'.repeat(900), bounce: { message: 'y'.repeat(300), subType: 'General', type: 'Permanent' } })
  db.queryRawRows = [{ ...auditRow('bounced', null), detail: long.slice(0, 1000) }]
  const findings = await runEventNotApplied()
  assert.equal(findings.length, 1, 'an unreadable bounce must not be assumed soft')
})

test('11c. consent check: a "complained" row with no suppression is a critical finding', async () => {
  db.queryRawRows = [auditRow('complained', { to: [NORMALIZED] })]
  const findings = await runEventNotApplied()
  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'critical')
})

// ════════════════════════════════════════════════════════════════════════
//  12. Cross-system suppression route reports a failed write
// ════════════════════════════════════════════════════════════════════════

async function postSuppression(body: Row) {
  const { NextRequest } = await import('next/server')
  const { POST } = await import('../../../app/api/email/suppression/route')
  const req = new NextRequest('http://localhost/api/email/suppression', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-suppression-key': SUPPRESSION_KEY },
    body: JSON.stringify(body),
  })
  const res = await POST(req)
  return { status: res.status, json: (await res.json()) as Row }
}

test('12a. suppression route POST: write failure → 500 ok:false retry:true', async () => {
  db.upsertFault = new Error('db down')
  const { status, json } = await postSuppression({ email: 'pushed@example.com', reason: 'HARD_BOUNCE', source: 'leadtracking' })
  assert.equal(status, 500)
  assert.equal(json.ok, false)
  assert.equal(json.error, 'write_failed')
  assert.equal(json.retry, true)
  assert.equal(db.suppressions.length, 0)
  await settle()
})

test('12b. suppression route POST: successful write → 200 ok:true', async () => {
  const { status, json } = await postSuppression({ email: 'pushed@example.com', reason: 'HARD_BOUNCE', source: 'leadtracking' })
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.status, 'created')
  assert.equal(db.suppressions.length, 1)
  assert.equal(db.suppressions[0].scope, 'all')
  await settle()
})
