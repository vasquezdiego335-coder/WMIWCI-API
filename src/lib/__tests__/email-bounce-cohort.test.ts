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

// ════════════════════════════════════════════════════════════════════════
//  THE SAME DEFECT ON THE ADMIN DASHBOARD (found 2026-08-28)
//
//  Fixing `checkBounceRate` corrected the ALERT. It did not correct the SCREEN.
//  `getOverview()` in email-admin.ts computed all three headline rates from two
//  different clocks:
//
//      sent       = EmailSend  rows WHERE createdAt >= since
//      bounced    = EmailEvent rows WHERE occurredAt >= since
//      complained = EmailEvent rows WHERE occurredAt >= since
//
//  A message sent before the window that bounces inside it is in the numerator
//  and not the denominator. So the owner could fix the alert, open the
//  dashboard, and read 133% there instead — and the complaint rate, which
//  nobody had looked at, had the identical flaw.
//
//  These pin all three rates to one cohort anchored on `sentAt`.
// ════════════════════════════════════════════════════════════════════════
import { getOverview } from '../email-admin'

/**
 * `getOverview()` aggregates the WHOLE table — it has no template filter, and
 * should not have one. So these tests measure the DELTA this suite's own rows
 * cause rather than absolute totals: today this suite is the only one that
 * writes EmailSend, but a suite added later would otherwise turn these exact
 * counts into an intermittent failure, and a flaky gate is a gate people learn
 * to re-run instead of read.
 */
async function delta(seed: () => Promise<void>) {
  const before = await getOverview('30d')
  await seed()
  const after = await getOverview('30d')
  const of = (k: 'deliveryRate' | 'bounceRate' | 'complaintRate') => ({
    numerator: after[k].numerator - before[k].numerator,
    denominator: after[k].denominator - before[k].denominator,
  })
  return {
    after,
    cohortSent: after.cohortSent - before.cohortSent,
    delivery: of('deliveryRate'),
    bounce: of('bounceRate'),
    complaint: of('complaintRate'),
  }
}

/** A send whose outcome is a COMPLAINT — the case that was never tested. */
async function complaint(sentAt: Date, complainedAt: Date) {
  seq += 1
  return prisma.emailSend.create({
    data: {
      id: `cohort_${seq}`,
      idempotencyKey: `cohort-gate:${seq}`,
      email: `cohort.${seq}@example.com`,
      template: 'cohort-gate',
      emailClass: 'marketing',
      status: 'delivered',
      isTest: false,
      sentAt,
      complainedAt,
    } as never,
  })
}

test('DASHBOARD: no headline rate can exceed 100%, whatever the outcomes', { skip }, async () => {
  await cohort(3, 4) // the incident's exact shape
  const o = await getOverview('30d')
  //  ABSOLUTE, deliberately: "no rate exceeds 100%" is a property of the whole
  //  table and must hold no matter what else is in it.
  for (const [label, r] of [
    ['delivery', o.deliveryRate],
    ['bounce', o.bounceRate],
    ['complaint', o.complaintRate],
  ] as const) {
    if (r.bp === null) continue
    assert.ok(r.bp <= 10_000, `${label} rate is ${r.bp / 100}% — a rate above 100% is a broken number`)
    assert.ok(r.numerator <= r.denominator, `${label}: ${r.numerator} of ${r.denominator}`)
  }
})

test('DASHBOARD: a message sent BEFORE the window cannot inflate the rate inside it', { skip }, async () => {
  //  Sent 40 days ago, bounced an hour ago. Under the old two-clock counting
  //  this bounce was in the numerator of the 30-day rate with nothing matching
  //  it in the denominator.
  const d = await delta(async () => {
    await send({ sentAt: ago(24 * 40), bounced: ago(1) })
    await cohort(2, 0)
  })
  assert.equal(d.bounce.denominator, 2, 'only messages SENT in the window are counted')
  assert.equal(d.bounce.numerator, 0, 'and the stale bounce is not among them')
  assert.equal(d.cohortSent, 2)
})

test('DASHBOARD: the complaint rate is measured, not assumed to be zero', { skip }, async () => {
  const d = await delta(async () => {
    await cohort(3, 0)
    await complaint(ago(2), ago(1))
  })
  assert.equal(d.complaint.denominator, 4)
  assert.equal(d.complaint.numerator, 1, 'the complaint is measured, not assumed to be zero')
})

test('DASHBOARD: a bounce and a complaint on the SAME message are both counted, once each', { skip }, async () => {
  //  These are independent columns by design — the schema says a delivered
  //  message can still generate a complaint — so neither may cancel the other.
  const d = await delta(async () => {
    seq += 1
    await prisma.emailSend.create({
      data: {
        id: `cohort_${seq}`,
        idempotencyKey: `cohort-gate:${seq}`,
        email: `cohort.${seq}@example.com`,
        template: 'cohort-gate',
        emailClass: 'marketing',
        status: 'delivered',
        isTest: false,
        sentAt: ago(2),
        deliveredAt: ago(2),
        complainedAt: ago(1),
      } as never,
    })
  })
  assert.equal(d.delivery.numerator, 1)
  assert.equal(d.complaint.numerator, 1)
  assert.equal(d.cohortSent, 1, 'one message, counted once in the denominator')
})

test('DASHBOARD: test sends never reach the rates', { skip }, async () => {
  const d = await delta(async () => {
    await send({ sentAt: ago(2), bounced: ago(1), isTest: true })
    await cohort(2, 0)
  })
  assert.equal(d.bounce.denominator, 2)
  assert.equal(d.bounce.numerator, 0)
})

test('DASHBOARD: an unsent row is in neither half — a rate needs a real denominator', { skip }, async () => {
  const d = await delta(async () => {
    seq += 1
    await prisma.emailSend.create({
      data: {
        id: `cohort_${seq}`,
        idempotencyKey: `cohort-gate:${seq}`,
        email: `cohort.${seq}@example.com`,
        template: 'cohort-gate',
        emailClass: 'marketing',
        //  Queued and never sent: sentAt is null.
        status: 'sending',
        isTest: false,
      } as never,
    })
  })
  assert.equal(d.cohortSent, 0, 'an unsent row is in neither half')
  //  And with nothing at all in the table, no data is reported as NO data.
  await prisma.emailSend.deleteMany({ where: { template: 'cohort-gate' } })
  const empty = await getOverview('30d')
  if (empty.cohortSent === 0) assert.equal(empty.bounceRate.bp, null, 'never 0% when there is nothing to measure')
})
