// ════════════════════════════════════════════════════════════════════════
//  email-bounce-cohort.test.ts — the bounce rate can no longer exceed 100%.
//
//  THE INCIDENT (2026-08-25). The owner monitor fired:
//
//      Hard-bounce rate is 133.33% (4 of 3 in 24h)
//
//  A rate cannot exceed 100%. The numerator and denominator described
//  DIFFERENT COHORTS: the numerator counted every row whose bouncedAt fell in
//  the window regardless of status, while the denominator counted only rows
//  with status 'delivered' — which structurally EXCLUDES every bounce. So the
//  ratio was bounces/(non-bounces) and grew without bound.
//
//  These tests pin the cohort itself, so the two halves can never drift apart
//  again. They run against a REAL PostgreSQL when DATABASE_URL points at one;
//  without it they skip rather than pretending to have proven anything.
//
//  All addresses are SYNTHETIC (example.com). No customer data appears here.
// ════════════════════════════════════════════════════════════════════════
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { checkBounceRate, RATE_WINDOW_HOURS, RATE_MIN_SAMPLE, BOUNCE_RATE_CRITICAL } from '../email-monitoring'

const skip = process.env.DATABASE_URL ? false : 'set DATABASE_URL to a disposable PostgreSQL to run the bounce-cohort gate'

let prisma: PrismaClient

before(async () => {
  if (skip) return
  prisma = new PrismaClient()
  await prisma.$connect()
})
after(async () => {
  if (skip) return
  await prisma.$disconnect()
})

const HOUR = 3600_000
const ago = (h: number) => new Date(Date.now() - h * HOUR)

let seq = 0
/** One EmailSend row. `sentAt` anchors the cohort; the outcome is terminal. */
async function send(opts: { sentAt: Date; delivered?: Date | null; bounced?: Date | null; isTest?: boolean }) {
  seq += 1
  return prisma.emailSend.create({
    data: {
      id: `cohort_${seq}`,
      idempotencyKey: `cohort-gate:${seq}`,
      email: `cohort.${seq}@example.com`,
      template: 'cohort-gate',
      emailClass: 'transactional',
      //  DELIBERATELY 'delivered' EVEN FOR A BOUNCE. The schema is explicit
      //  that `status` records only that the PROVIDER ACCEPTED THE API CALL —
      //  "a hard-bounced send still read as delivered forever" — and that the
      //  authoritative outcome lives in deliveredAt/bouncedAt. Seeding the
      //  worst case proves the cohort no longer depends on `status` at all.
      status: 'delivered',
      isTest: opts.isTest ?? false,
      sentAt: opts.sentAt,
      deliveredAt: opts.delivered ?? null,
      bouncedAt: opts.bounced ?? null,
    } as never,
  })
}

beforeEach(async () => {
  if (skip) return
  await prisma.emailSend.deleteMany({ where: { template: 'cohort-gate' } })
})

/** n messages that all reached a terminal outcome inside the window. */
async function cohort(delivered: number, bounced: number) {
  for (let i = 0; i < delivered; i++) await send({ sentAt: ago(2), delivered: ago(1) })
  for (let i = 0; i < bounced; i++) await send({ sentAt: ago(2), bounced: ago(1) })
}

test('THE INCIDENT: 4 bounced + 3 delivered is 57%, never 133%', { skip }, async () => {
  await cohort(3, 4)
  const c = await checkBounceRate()
  //  7 terminal outcomes is BELOW the sample floor, so it must not escalate —
  //  but the arithmetic itself must already be sane.
  assert.ok((c.value ?? 0) <= 1, `a rate may never exceed 100%, got ${c.value}`)
  assert.ok(Math.abs((c.value ?? 0) - 4 / 7) < 1e-9, `expected 4/7, got ${c.value}`)
  assert.doesNotMatch(c.message, /of 3 /, 'the denominator must be the whole cohort, not the non-bounces')
})

test('the bounce count is always a SUBSET of the denominator', { skip }, async () => {
  //  The property the old code violated. Whatever the mix, 0 <= r <= 1.
  for (const [d, b] of [[0, 5], [5, 0], [1, 9], [9, 1], [12, 12]]) {
    await prisma.emailSend.deleteMany({ where: { template: 'cohort-gate' } })
    await cohort(d, b)
    const c = await checkBounceRate()
    const r = c.value ?? 0
    assert.ok(r >= 0 && r <= 1, `d=${d} b=${b} produced ${r}`)
  }
})

test('a bounced-only cohort is 100%, not infinity', { skip }, async () => {
  await cohort(0, RATE_MIN_SAMPLE)
  const c = await checkBounceRate()
  assert.equal(c.value, 1)
  assert.equal(c.severity, 'critical')
})

test('a delivered-only cohort is 0% and stays quiet', { skip }, async () => {
  await cohort(RATE_MIN_SAMPLE, 0)
  const c = await checkBounceRate()
  assert.equal(c.value, 0)
  assert.equal(c.severity, 'ok')
})

test('ONE time anchor: sent BEFORE the window but bounced inside it is excluded', { skip }, async () => {
  //  The old numerator filtered on bouncedAt and the denominator on sentAt, so
  //  a message sent last week that bounced today counted in the numerator and
  //  could never appear in the denominator. Both halves now anchor on sentAt.
  await cohort(RATE_MIN_SAMPLE, 0)
  await send({ sentAt: ago(RATE_WINDOW_HOURS + 48), bounced: ago(1) })
  const c = await checkBounceRate()
  assert.equal(c.value, 0, 'an out-of-window send must not inflate an in-window rate')
})

test('a message sent inside the window with NO terminal outcome yet is not counted', { skip }, async () => {
  await cohort(RATE_MIN_SAMPLE, 0)
  await send({ sentAt: ago(1) }) // still in flight
  const c = await checkBounceRate()
  assert.match(c.message, new RegExp(`${RATE_MIN_SAMPLE} terminal outcomes`), 'in-flight mail is not an outcome')
})

test('test sends never contaminate the cohort', { skip }, async () => {
  await cohort(RATE_MIN_SAMPLE, 0)
  for (let i = 0; i < 5; i++) await send({ sentAt: ago(2), bounced: ago(1), isTest: true })
  const c = await checkBounceRate()
  assert.equal(c.value, 0, 'isTest rows must be excluded from both halves')
})

test('below the sample floor it REPORTS but never escalates to critical', { skip }, async () => {
  await cohort(1, 2) // 3 outcomes, 66% — meaningless as a rate
  const c = await checkBounceRate()
  assert.notEqual(c.severity, 'critical', 'three messages must not page the owner about a "rate"')
  assert.match(c.message, /[Tt]oo small a sample/)
  assert.match(c.message, new RegExp(`minimum ${RATE_MIN_SAMPLE}`), 'and must say what the floor is')
  //  The bounces are still surfaced — a hard bounce is a real dead address.
  assert.equal(c.severity, 'warn')
})

test('exactly at the sample floor the rate becomes authoritative', { skip }, async () => {
  const bounced = Math.ceil(RATE_MIN_SAMPLE * BOUNCE_RATE_CRITICAL) + 1
  await cohort(RATE_MIN_SAMPLE - bounced, bounced)
  const c = await checkBounceRate()
  assert.equal(c.severity, 'critical', `at n=${RATE_MIN_SAMPLE} a genuinely bad rate must still fire`)
  assert.match(c.message, /Hard-bounce rate is/)
  assert.match(c.message, /terminal outcomes/)
})

test('zero outcomes is reported as no data, not as a zero rate', { skip }, async () => {
  const c = await checkBounceRate()
  assert.equal(c.severity, 'ok')
  assert.match(c.message, /No email sent in the window/)
})

test('the correction does NOT silence a genuine list-quality problem', { skip }, async () => {
  //  The whole point: fixing impossible arithmetic must not become a way to
  //  stop hearing about bad addresses.
  await cohort(RATE_MIN_SAMPLE, RATE_MIN_SAMPLE)
  const c = await checkBounceRate()
  assert.equal(c.value, 0.5)
  assert.equal(c.severity, 'critical')
  assert.match(c.action ?? '', /Pause campaigns/)
})

test('running the monitor twice does not change the answer', { skip }, async () => {
  await cohort(RATE_MIN_SAMPLE, 2)
  const a = await checkBounceRate()
  const b = await checkBounceRate()
  assert.deepEqual({ v: a.value, s: a.severity }, { v: b.value, s: b.severity }, 'the monitor is read-only and stable')
})
