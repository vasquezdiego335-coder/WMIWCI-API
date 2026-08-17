// ════════════════════════════════════════════════════════════════════════════
//  lifecycle-release.test.ts — ITEMS C3 (three narrow lifecycle holes) and C4
//  (the owner's release action skipped the half both its twins perform).
//
//  WHAT IS REPRODUCED HERE, THEN FIXED (docs/moving-os-customer-truth.md):
//
//   C3-1  `cancelJobForBooking` reported a THROWN booking read as a deliberate
//         skip (`not_found`) — the same defect as the write seam one line down,
//         where a failure wore the word "skipped". An unreadable booking may
//         have a live Job and live crew on a cancelled move: that is owed work.
//
//   C3-2  Nothing read the `failed` field the previous fix added. Both shipped
//         callers `await cancelJobForBooking(...)` for its side effects and
//         discard the answer, so a failure was RECORDED and never SURFACED.
//
//   C3-3  `cancelBooking` reported `already_cancelled` when its conditional
//         claim matched zero rows — including when the booking had just become
//         COMPLETED (the Discord move-day card is one tap). The admin route
//         then emails the customer a cancellation for a move that already
//         happened. That one reaches a real person.
//
//   C4    The owner's truck-hold release cancels the booking and stopped there:
//         no Job, no crew, no journey/enrolment stop, and — after an
//         ACKNOWLEDGED release — a Stripe checkout session still payable on a
//         booking nothing in this system can capture, release or refund.
//
//  HOW THIS FILE TESTS (the house rules for this round):
//   • THE SHIPPED CODE RUNS. `lifecycle-service.ts` and `checkout-expiry.ts`
//     are imported for real and driven against the fake Prisma client installed
//     before `src/lib/db.ts` loads (`_effect-report-harness.ts`), whose
//     `$transaction` is atomic and whose `auditLog.create` enforces the primary
//     key — so a rollback is something this file can SEE.
//   • THE BOOKING ROW COMES FROM THE SHIPPED WRITER (`buildBookingCreateData`
//     via the harness's `seedBooking`), never from a hand-made fixture.
//   • THE WRITERS ARE THE SHIPPED ONES: `defaultCheckoutExpiryDeps()` supplies
//     the real `readHold` / `releaseTruckHold`, so the WHERE clauses under test
//     are production's. Only the Stripe edge, the clock, the logger and the
//     BullMQ-backed journey stop are injected.
//   • MUTATION-TESTED. Every section starts by reproducing the ORIGINAL defect
//     against the same harness, so a green fix cannot be green by accident.
//
//  Offline: no database, no Stripe, no Redis, no network.
//    npx tsx --test src/lib/__tests__/lifecycle-release.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ── Environment, BEFORE any app import ──────────────────────────────────────
process.env.STRIPE_SECRET_KEY = 'sk_test_lifecycle_release'
process.env.APP_URL = 'https://example.test'
// C3-2 raises a failed crew cancellation through the ops-alert primitive. With
// no token it reports "not configured" and touches no network — a test must
// never be able to post to the live Discord.
delete process.env.DISCORD_BOT_TOKEN
delete process.env.EMAIL_JOURNEYS_ENABLED
delete process.env.MARKETING_FOLLOWUPS_ENABLED

import {
  installFakePrisma,
  assertUsingFake,
  seedBooking,
  theDb,
  quietLogger,
  type Row,
} from './_effect-report-harness'

installFakePrisma()

type Mods = {
  lifecycle: typeof import('../lifecycle-service')
  expiry: typeof import('../checkout-expiry')
}
let mods: Mods | null = null

async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    lifecycle: await import('../lifecycle-service'),
    expiry: await import('../checkout-expiry'),
  }
  await assertUsingFake()
  assert.equal(process.env.DISCORD_BOT_TOKEN, undefined, 'a test must never be able to post to the live Discord')
  return mods
}

const db = theDb
const AT = new Date('2027-07-15T21:00:00.000Z')
const NOW = Date.parse('2027-07-01T15:00:00.000Z')
const OWNER = { userId: 'u_diego', name: 'Diego', role: 'OWNER' as const }

const booking = (): Row => db().bookings.get('bk_life')!
const job = (): Row | undefined => db().jobs.get('bk_life')
const crew = (id: string): Row => db().jobCrew.get(id)!

/** An UNPAID checkout hold, written by the shipped admin Book Move path, with
 *  a Job and live crew already attached — which is reachable today:
 *  POST /api/admin/jobs/[id]/crew calls `ensureJobForBooking` with no status
 *  check, so crew can be on a booking before its deposit is ever paid. */
async function seedHold(over: Row = {}): Promise<void> {
  await seedBooking(
    {
      status: 'PENDING_PAYMENT',
      depositPaid: false,
      stripeCheckoutId: 'cs_A',
      stripePaymentIntentId: null,
      truckId: 'truck_16ft',
      createdAt: new Date(NOW - 30 * 3_600_000),
      ...over,
    },
    {
      job: { status: 'SCHEDULED', startedAt: null },
      crew: [
        { id: 'jc_1', assignmentStatus: 'ASSIGNED' },
        { id: 'jc_2', assignmentStatus: 'ACCEPTED' },
      ],
    },
  )
}

// ── The injected edge: Stripe, the clock, and the journey stop ──────────────

type Edge = {
  sessions: Map<string, Row>
  retrieveError?: Error
  expireError?: Error
  expired: string[]
  alerts: Array<{ title: string; lines: Array<{ message: string; action?: string }> }>
  /** Every booking whose journeys + enrolments were told to stop. */
  journeysStopped: string[]
  journeyError?: Error
}

const edge = (): Edge => ({ sessions: new Map(), expired: [], alerts: [], journeysStopped: [] })

/** The lifecycle fan-out with ONLY the queue-backed journey stop replaced:
 *  `journeys.onBookingCancelled` removes ~11 BullMQ jobs, and a queue with no
 *  Redis behind it spends five seconds per id failing to answer. The DECISION
 *  to stop them is still entirely the shipped service's. */
function lifecycleDeps(e: Edge): import('../lifecycle-service').LifecycleDeps {
  return {
    logger: quietLogger,
    effects: {
      async sendCompletionEmail() {
        return false
      },
      async scheduleFollowups() {
        return { scheduled: 0, failed: 0, total: 0, reason: 'followups_disabled' }
      },
      async scheduleBalanceReminder() {
        return { scheduled: false, reason: 'journeys_disabled' }
      },
      async stopJourneys(bookingId: string) {
        if (e.journeyError) throw e.journeyError
        e.journeysStopped.push(bookingId)
      },
      async alertCrewCancelFailed(input) {
        e.alerts.push({
          title: 'A cancelled move may still have live crew',
          lines: [{ message: `${input.displayId ?? input.bookingId}: ${input.reason}` }],
        })
      },
    },
  }
}

/** The SHIPPED checkout-expiry deps — real `readHold`, real `releaseTruckHold`
 *  (the conditional claim + its audit row in one transaction) and the REAL
 *  `finishCancellationViaLifecycle`, which is the thing C4 adds. Only Stripe,
 *  the log, the clock and the journey queue are injected. */
async function releaseDeps(e: Edge) {
  const m = await load()
  return {
    ...m.expiry.defaultCheckoutExpiryDeps(),
    async retrieveSession(id: string) {
      if (e.retrieveError) throw e.retrieveError
      return (e.sessions.get(id) as never) ?? null
    },
    async expireSession(id: string) {
      if (e.expireError) throw e.expireError
      e.expired.push(id)
      const s = e.sessions.get(id)
      if (s) s.status = 'expired'
    },
    finishCancellation: (input: import('../checkout-expiry').FinishCancellationInput) =>
      m.expiry.finishCancellationViaLifecycle(input, lifecycleDeps(e)),
    async alert(title: string, lines: Array<{ message: string; action?: string }>) {
      e.alerts.push({ title, lines })
      return { delivered: true }
    },
    log: { info() {}, warn() {}, error() {} },
    now: () => NOW,
  }
}

const SESSION_TTL_SEC = 30 * 60
const sec = (ms: number): number => Math.floor(ms / 1000)

/** A Stripe session as the shipped creator makes it. */
function session(id: string, createdMs: number, over: Partial<Row> = {}): Row {
  return {
    id,
    status: 'expired',
    payment_status: 'unpaid',
    created: sec(createdMs),
    expires_at: sec(createdMs) + SESSION_TTL_SEC,
    ...over,
  }
}

/** Make the next booking READ throw, the way an unreachable Neon does. */
async function withUnreadableBooking<T>(err: Error, fn: () => Promise<T>): Promise<T> {
  const prisma = (await import('../db')).prisma as unknown as {
    booking: { findUnique(a: unknown): Promise<unknown> }
  }
  const real = prisma.booking.findUnique.bind(prisma.booking)
  prisma.booking.findUnique = async () => {
    throw err
  }
  try {
    return await fn()
  } finally {
    prisma.booking.findUnique = real
  }
}

const ROOT = process.cwd()
const readSrc = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8')

// ════════════════════════════════════════════════════════════════════════════
//  C3-1 — A THROWN READ IS NOT A SKIP
// ════════════════════════════════════════════════════════════════════════════

test('DEFECT C3-1: the pre-fix read seam turns an unreadable database into "nothing to do"', async () => {
  const m = await load()
  await seedHold({ status: 'CANCELLED' })

  // The shipped body, as it was: one `.catch(() => null)` over the read, and
  // `null` funnelled into the same `not_found` skip a missing booking produces.
  const preFix = async (): Promise<Row> => {
    const b = await m.lifecycle.loadLifecycleBooking('bk_life').catch(() => null)
    if (!b) return { jobCancelled: false, crewCancelled: 0, skipped: 'not_found' }
    return { jobCancelled: false, crewCancelled: 0, skipped: `status:${b.status}` }
  }

  const out = await withUnreadableBooking(new Error("Can't reach database server"), preFix)

  assert.equal(out.skipped, 'not_found', 'THE DEFECT: an infrastructure failure reported as a deliberate skip')
  assert.equal(out.failed, undefined, 'and nothing tells the caller the remediation is still owed')
  assert.equal(crew('jc_1').assignmentStatus, 'ASSIGNED', 'while the crew of a CANCELLED move is still live')
})

test('C3-1: a thrown booking read is reported as FAILED, and raised', async () => {
  const m = await load()
  await seedHold({ status: 'CANCELLED' })
  const e = edge()

  const out = await withUnreadableBooking(new Error("Can't reach database server"), () =>
    m.lifecycle.cancelJobForBooking(
      { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
      lifecycleDeps(e),
    ),
  )

  assert.match(out.failed ?? '', /Can't reach database server/, 'the caller can see that remediation is still owed')
  assert.match(out.failed ?? '', /read/i, 'and where it failed')
  assert.equal(out.skipped, undefined, 'a failure must never wear the word "skipped"')
  assert.equal(e.alerts.length, 1, 'and a human is told, because only a human can finish it')
  assert.equal(db().audits.size, 0, 'nothing was written, so nothing is recorded as done')
})

test('C3-1: a booking that genuinely does not exist is STILL a skip', async () => {
  const m = await load()
  await seedHold({ status: 'CANCELLED' })
  const e = edge()

  const out = await m.lifecycle.cancelJobForBooking(
    { bookingId: 'bk_missing', actor: { name: 'diego' }, source: 'admin', at: AT },
    lifecycleDeps(e),
  )

  assert.equal(out.skipped, 'not_found', 'the honest no-op keeps its honest name')
  assert.equal(out.failed, undefined)
  assert.equal(e.alerts.length, 0, 'and nobody is paged for a booking that was never there')
})

// ════════════════════════════════════════════════════════════════════════════
//  C3-2 — A FAILURE THAT NOBODY READS IS A FAILURE NOBODY KNOWS ABOUT
// ════════════════════════════════════════════════════════════════════════════

test('DEFECT C3-2: the pre-fix callers discard `failed`, so the only artifact is a log line', async () => {
  const m = await load()
  await seedHold({ status: 'CANCELLED' })
  db().failOn = { op: 'jobCrew.updateMany', error: new Error('Neon: connection terminated') }
  const e = edge()

  // Both shipped call sites did exactly this: awaited it for the side effects
  // and threw the answer away. (The alert did not exist, so the fan-out here is
  // the pre-fix one.)
  await m.lifecycle.cancelJobForBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    { logger: quietLogger, effects: { ...lifecycleDeps(e).effects!, alertCrewCancelFailed: undefined } },
  )

  assert.equal(crew('jc_1').assignmentStatus, 'ASSIGNED', 'THE DEFECT: live crew on a cancelled move…')
  assert.equal(e.alerts.length, 0, '…and not one thing outside the function knows it failed')
})

test('C3-2: a failed crew cancellation is raised to the owner, naming the hand-work it leaves', async () => {
  const m = await load()
  await seedHold({ status: 'CANCELLED' })
  db().failOn = { op: 'jobCrew.updateMany', error: new Error('Neon: connection terminated') }
  const e = edge()

  const out = await m.lifecycle.cancelJobForBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'discord', at: AT },
    lifecycleDeps(e),
  )

  assert.match(out.failed ?? '', /connection terminated/)
  assert.equal(e.alerts.length, 1, 'the failure reaches a human regardless of what the caller does with it')
  assert.match(e.alerts[0].lines[0].message, /connection terminated/)
})

test('C3-2: the SHIPPED default alert says only what the database showed, and no money word', async () => {
  const m = await load()
  const effects = m.lifecycle.defaultLifecycleEffects()
  assert.equal(typeof effects.alertCrewCancelFailed, 'function', 'the default fan-out must supply it')

  // Run the real one: with no DISCORD_BOT_TOKEN `postOpsAlert` returns
  // "not configured" without a network call, and never throws.
  await effects.alertCrewCancelFailed!({
    bookingId: 'bk_life',
    displayId: 'WMIC-1042',
    reason: 'Neon: connection terminated',
    source: 'admin',
  })

  // The wording itself is pinned at the source, because the transport swallows
  // it when unconfigured. It must name the booking and the hand-work, and must
  // not state anything about money.
  const src = readSrc('src/lib/lifecycle-service.ts')
  const start = src.indexOf('async alertCrewCancelFailed(')
  assert.ok(start > -1, 'the default implementation must exist')
  const body = src.slice(start, src.indexOf('\n    },', start))
  assert.match(body, /is CANCELLED, but its job and crew assignments could not be cancelled/)
  assert.match(body, /by hand/, 'the owner is told what only they can do')
  assert.equal(
    /\b(?:was|were|is|are|has been|have been)\s+(?:not\s+)?(?:charged|captured|refunded|collected)\b/i.test(body),
    false,
    'an alert about crew may not state a payment outcome',
  )
})

test('C3-2: the shipped decline route READS the failure instead of discarding it', () => {
  const route = readSrc('app/api/admin/bookings/[id]/status/route.ts')
  const call = route.indexOf('cancelJobForBooking({')
  assert.ok(call > -1, 'the decline path must still finish the crew half')
  const after = route.slice(call, call + 1400)
  assert.match(route.slice(Math.max(0, call - 200), call), /const crew = await\s*$/m, 'its result must be bound…')
  assert.match(after, /crew\.failed/, '…and read')
  assert.match(after, /jobCancelFailed/, 'and returned to the caller')
})

// ════════════════════════════════════════════════════════════════════════════
//  C3-3 — `already_cancelled` FOR A MOVE THAT ALREADY HAPPENED
// ════════════════════════════════════════════════════════════════════════════

/** Complete the booking between `cancelBooking`'s read and its claim — the
 *  Discord move-day card is one tap, and this route is four clicks. */
async function completeDuringTheClaim(): Promise<void> {
  db().before = {
    op: 'booking.updateMany',
    run: () => {
      booking().status = 'COMPLETED'
      booking().completedAt = AT
    },
  }
}

test('DEFECT C3-3: the pre-fix mapping calls a COMPLETED booking "already cancelled"', async () => {
  const m = await load()
  await seedHold({ status: 'CONFIRMED', depositPaid: true })
  await completeDuringTheClaim()

  // The shipped claim, unchanged, with the mapping as it was: zero rows matched
  // was read as "somebody else cancelled it".
  const claimed = await (async () => {
    const prisma = (await import('../db')).prisma as unknown as {
      booking: { updateMany(a: unknown): Promise<{ count: number }> }
    }
    const claim = await prisma.booking.updateMany({
      where: { id: 'bk_life', status: { in: [...m.lifecycle.CANCELLABLE_STATUSES] } },
      data: { status: 'CANCELLED' },
    })
    return claim.count > 0
  })()
  const preFix = claimed ? { ok: true, outcome: 'cancelled' } : { ok: true, outcome: 'already_cancelled' }

  assert.equal(booking().status, 'COMPLETED', 'the move happened')
  assert.equal(preFix.outcome, 'already_cancelled', 'THE DEFECT: reported as a cancellation that already happened')
  assert.equal(preFix.ok, true, 'and `ok`, which is the whole gate the route puts in front of the customer email')
})

test('C3-3: THE EMAIL — the route sends a cancellation on ANY ok result, so ok must be provable', () => {
  const route = readSrc('app/api/admin/bookings/[id]/status/route.ts')
  const branch = route.slice(route.indexOf("if (newStatus === 'CANCELLED') {"))
  const guard = branch.indexOf('if (!result.ok)')
  const email = branch.indexOf('await sendCancellationEmail(')
  assert.ok(guard > -1 && email > guard, 'the only gate before the customer email is `result.ok`')
  assert.equal(
    branch.slice(guard, email).includes('outcome'),
    false,
    'the route does not inspect the outcome — so `ok: true` alone puts an email in a customer inbox',
  )
})

test('C3-3: a booking COMPLETED under the claim is refused, not reported as cancelled', async () => {
  const m = await load()
  await seedHold({ status: 'CONFIRMED', depositPaid: true })
  await completeDuringTheClaim()
  const e = edge()

  const res = await m.lifecycle.cancelBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    lifecycleDeps(e),
  )

  assert.equal(res.ok, false, 'no email may follow a cancellation that did not happen')
  assert.equal(!res.ok && res.code, 'invalid_status')
  assert.match(!res.ok ? res.message : '', /completed/i, 'and the owner is told what the booking actually is')
  assert.equal(
    /cancelled\b/i.test((!res.ok && res.message) || ''),
    true,
    'stating plainly that it was NOT cancelled',
  )
  assert.equal(booking().status, 'COMPLETED', 'and the completed move is untouched')
  assert.equal(booking().completedAt instanceof Date, true)
})

test('C3-3: a re-read that fails claims nothing about the booking either', async () => {
  const m = await load()
  await seedHold({ status: 'CONFIRMED', depositPaid: true })
  const e = edge()
  // The claim matches nothing AND the row cannot be re-read.
  db().before = {
    op: 'booking.updateMany',
    run: () => {
      booking().status = 'COMPLETED'
    },
  }
  const prisma = (await import('../db')).prisma as unknown as {
    booking: { findUnique(a: unknown): Promise<unknown> }
  }
  const real = prisma.booking.findUnique.bind(prisma.booking)
  let reads = 0
  prisma.booking.findUnique = async (a: unknown) => {
    reads += 1
    if (reads > 1) throw new Error('Neon: connection terminated')
    return real(a)
  }
  try {
    const res = await m.lifecycle.cancelBooking(
      { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
      lifecycleDeps(e),
    )
    assert.equal(res.ok, false)
    assert.equal(!res.ok && res.code, 'write_failed')
    assert.match(!res.ok ? res.message : '', /NOT cancelled/i)
  } finally {
    prisma.booking.findUnique = real
  }
})

test('C3-3: a booking somebody else really cancelled still reports already_cancelled — and finishes the crew half', async () => {
  const m = await load()
  await seedHold({ status: 'CONFIRMED', depositPaid: true })
  const e = edge()
  // The other caller wins the claim: the row IS cancelled, and (like
  // declineBooking, which owns the hold release and the claim but not the Job)
  // it left the crew live.
  db().before = {
    op: 'booking.updateMany',
    run: () => {
      booking().status = 'CANCELLED'
    },
  }

  const res = await m.lifecycle.cancelBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT, effects: false },
    lifecycleDeps(e),
  )

  assert.ok(res.ok)
  assert.equal(res.ok && res.outcome, 'already_cancelled', 'the database SHOWS it cancelled, so this is provable')
  assert.equal(res.ok && res.claimed, false)
  assert.equal(res.ok && res.crewCancelled, 2, 'and the half the winner did not do is finished here')
  assert.equal(job()!.status, 'CANCELLED')
  assert.equal(crew('jc_1').assignmentStatus, 'CANCELLED')
})

// ════════════════════════════════════════════════════════════════════════════
//  C4 — THE RELEASE MUST DO WHAT ITS TWINS DO
// ════════════════════════════════════════════════════════════════════════════

test('DEFECT C4: the pre-fix release cancels the booking and leaves everything else alive', async () => {
  const m = await load()
  await seedHold()
  const e = edge()
  e.sessions.set('cs_A', session('cs_A', NOW - 10 * 60_000, { status: 'open' }))
  const deps = await releaseDeps(e)

  // The pre-fix release WAS exactly this: the shipped writer, and nothing else.
  const count = await deps.releaseTruckHold({
    bookingId: 'bk_life',
    actorUserId: OWNER.userId,
    actorName: OWNER.name,
    sessionId: 'cs_A',
    sessionVerdict: 'payable',
    acknowledgedRisk: true,
  })

  assert.equal(count, 1, 'the booking is cancelled…')
  assert.equal(booking().status, 'CANCELLED')
  assert.equal(job()!.status, 'SCHEDULED', 'THE DEFECT: the Job stays live, so more crew can still be assigned to it')
  assert.equal(crew('jc_1').assignmentStatus, 'ASSIGNED', 'THE DEFECT: the move stays in the crew\'s upcoming list')
  assert.deepEqual(e.journeysStopped, [], 'THE DEFECT: its emails and enrolments keep running')
  assert.deepEqual(e.expired, [], 'THE DEFECT: and the session stays payable on a booking nothing can consume')
  assert.equal(e.sessions.get('cs_A')!.status, 'open')
})

test('C4: the owner release now finishes the cancellation — job, crew, journeys and the session', async () => {
  const m = await load()
  await seedHold()
  const e = edge()
  e.sessions.set('cs_A', session('cs_A', NOW - 10 * 60_000, { status: 'open' }))

  const res = await m.expiry.releaseTruckHoldByOwner(
    { bookingId: 'bk_life', actor: OWNER, acknowledgeRisk: true },
    await releaseDeps(e),
  )

  assert.equal(res.ok, true)
  assert.equal(res.ok && res.outcome, 'released')
  assert.equal(booking().status, 'CANCELLED')
  assert.equal(booking().truckId, 'truck_16ft', "the owner's assignment intent is still preserved")

  assert.equal(job()!.status, 'CANCELLED', 'the Job is cancelled, so ASSIGNMENT_ON_CANCELLED_JOB can fire')
  assert.equal(crew('jc_1').assignmentStatus, 'CANCELLED')
  assert.equal(crew('jc_2').assignmentStatus, 'CANCELLED')
  assert.equal(crew('jc_1').cancelReason, 'Truck hold released by owner', 'and the crew are told why')
  assert.deepEqual(e.journeysStopped, ['bk_life'], 'journeys AND automation enrolments are stopped')
  assert.deepEqual(e.expired, ['cs_A'], 'the payable session is retired')

  assert.equal(res.ok && res.aftermath?.crewCancelled, 2)
  assert.equal(res.ok && res.aftermath?.jobCancelled, true)
  assert.equal(res.ok && res.aftermath?.journeys, 'ok')
  assert.equal(res.ok && res.sessionRetired, 'yes')
})

test('C4: PARITY — all three cancellation paths leave the same job/crew shape', async () => {
  const m = await load()
  const e = edge()
  const shape = (): Row => ({
    job: job()!.status,
    jc_1: crew('jc_1').assignmentStatus,
    jc_2: crew('jc_2').assignmentStatus,
  })

  // Twin 1 — the admin cancellation of an approved move.
  await seedHold({ status: 'CONFIRMED', depositPaid: true })
  await m.lifecycle.cancelBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT },
    lifecycleDeps(e),
  )
  const viaCancel = shape()

  // Twin 2 — the decline path: declineBooking claims the row, then the route
  // calls cancelJobForBooking for the half it does not own.
  await seedHold({ status: 'CANCELLED' })
  await m.lifecycle.cancelJobForBooking(
    { bookingId: 'bk_life', actor: { name: 'diego' }, source: 'admin', at: AT, reason: 'Booking declined' },
    lifecycleDeps(e),
  )
  const viaDecline = shape()

  // The one under test.
  await seedHold()
  await m.expiry.releaseTruckHoldByOwner({ bookingId: 'bk_life', actor: OWNER }, await releaseDeps(e))
  const viaRelease = shape()

  assert.deepEqual(viaCancel, { job: 'CANCELLED', jc_1: 'CANCELLED', jc_2: 'CANCELLED' })
  assert.deepEqual(viaRelease, viaCancel, 'the release must not be the one path that leaves a live crew behind')
  assert.deepEqual(viaRelease, viaDecline)
})

test('C4: a COMPLETED assignment is never unmade by any of them', async () => {
  const m = await load()
  await seedBooking(
    { status: 'PENDING_PAYMENT', depositPaid: false, stripeCheckoutId: null, stripePaymentIntentId: null },
    { job: { status: 'SCHEDULED' }, crew: [{ id: 'jc_1', assignmentStatus: 'COMPLETED' }] },
  )
  const e = edge()

  await m.expiry.releaseTruckHoldByOwner({ bookingId: 'bk_life', actor: OWNER }, await releaseDeps(e))

  assert.equal(crew('jc_1').assignmentStatus, 'COMPLETED', 'work that really happened is not unmade by a cancellation')
  assert.equal(job()!.status, 'CANCELLED')
})

test('C4: the release refuses to touch the job of a booking it did NOT cancel', async () => {
  const m = await load()
  await seedHold({ status: 'CONFIRMED', depositPaid: true })
  const e = edge()

  const res = await m.expiry.releaseTruckHoldByOwner(
    { bookingId: 'bk_life', actor: OWNER, acknowledgeRisk: true },
    await releaseDeps(e),
  )

  assert.equal(res.ok, false, 'a captured booking belongs to decline/refund, not here')
  assert.equal(job()!.status, 'SCHEDULED', 'and nothing about a LIVE move was changed')
  assert.equal(crew('jc_1').assignmentStatus, 'ASSIGNED')
  assert.deepEqual(e.journeysStopped, [])
  assert.deepEqual(e.expired, [])
})

test('C4: the session is retired only AFTER the claim, and never for a refused release', async () => {
  const m = await load()
  // A booking that raced: the row is gone from PENDING_PAYMENT before the write.
  await seedHold()
  const e = edge()
  e.sessions.set('cs_A', session('cs_A', NOW - 10 * 60_000, { status: 'open' }))
  db().before = {
    op: 'booking.updateMany',
    run: () => {
      booking().status = 'CONFIRMED'
      booking().depositPaid = true
    },
  }

  const res = await m.expiry.releaseTruckHoldByOwner(
    { bookingId: 'bk_life', actor: OWNER, acknowledgeRisk: true },
    await releaseDeps(e),
  )

  assert.equal(res.ok, false)
  assert.equal(!res.ok && res.code, 'raced')
  assert.deepEqual(e.expired, [], 'killing a live checkout for a booking that stayed payable is the worse mistake')
  assert.equal(e.sessions.get('cs_A')!.status, 'open')
  assert.deepEqual(e.journeysStopped, [], 'and a booking nobody cancelled keeps its journeys')
})

test('C4: an already-expired session is not "retired" by this call, and says nothing about one', async () => {
  const m = await load()
  await seedHold()
  const e = edge()
  e.sessions.set('cs_A', session('cs_A', NOW - 29 * 3_600_000)) // status 'expired'

  const res = await m.expiry.releaseTruckHoldByOwner({ bookingId: 'bk_life', actor: OWNER }, await releaseDeps(e))

  assert.equal(res.ok && res.sessionVerdict, 'expired')
  assert.equal(res.ok && res.sessionRetired, 'not-attempted', 'there was nothing to retire')
  assert.deepEqual(e.expired, [])
  assert.equal(/checkout session was expired/.test((res.ok && res.message) || ''), false, 'so the message claims none')
})

test('C4: an expiry Stripe did not confirm is reported as unknown, never as done', async () => {
  const m = await load()
  await seedHold()
  const e = edge()
  e.sessions.set('cs_A', session('cs_A', NOW - 10 * 60_000, { status: 'open' }))
  e.expireError = new Error('Stripe API unavailable (503)')

  const res = await m.expiry.releaseTruckHoldByOwner(
    { bookingId: 'bk_life', actor: OWNER, acknowledgeRisk: true },
    await releaseDeps(e),
  )

  assert.equal(res.ok, true, 'the release itself stands — the booking is cancelled')
  assert.equal(res.ok && res.sessionRetired, 'unknown')
  const message = res.ok ? res.message : ''
  assert.match(message, /did NOT confirm/, 'and the owner is sent to Stripe rather than reassured')
  assert.equal(/session was expired, so it can no longer be paid/.test(message), false)
})

test('C4: an unreadable Stripe is still worth retiring the session over — and the release survives', async () => {
  const m = await load()
  await seedHold()
  const e = edge()
  e.retrieveError = new Error('Stripe API unavailable (503)')

  const res = await m.expiry.releaseTruckHoldByOwner(
    { bookingId: 'bk_life', actor: OWNER, acknowledgeRisk: true },
    await releaseDeps(e),
  )

  assert.equal(res.ok && res.sessionVerdict, 'unreadable', '"cannot tell" is not "expired"')
  assert.deepEqual(e.expired, ['cs_A'], 'a session that may still be payable on a cancelled booking is retired')
  assert.equal(res.ok && res.sessionRetired, 'yes')
})

test('C4: a failed crew half never breaks the release, and never reads as a quiet zero', async () => {
  const m = await load()
  await seedHold()
  const e = edge()
  db().failOn = { op: 'jobCrew.updateMany', error: new Error('Neon: connection terminated') }

  const res = await m.expiry.releaseTruckHoldByOwner({ bookingId: 'bk_life', actor: OWNER }, await releaseDeps(e))

  assert.equal(res.ok, true, 'the truck hold IS released — that write committed')
  assert.equal(booking().status, 'CANCELLED')
  assert.match((res.ok && res.aftermath?.jobCancelFailed) ?? '', /connection terminated/)
  assert.equal(res.ok && res.aftermath?.crewCancelled, 0)
  assert.match(res.ok ? res.message : '', /could NOT be cancelled/, 'and the owner is told to finish it by hand')
  assert.equal(e.alerts.some((a) => /live crew/i.test(a.title)), true, 'and it is raised as well as returned')
})

test('C4: a journey stop that failed is not reported as a booking whose emails were stopped', async () => {
  const m = await load()
  await seedHold()
  const e = edge()
  e.journeyError = new Error('scheduledQueue.getJob timed out (Redis?)')

  const res = await m.expiry.releaseTruckHoldByOwner({ bookingId: 'bk_life', actor: OWNER }, await releaseDeps(e))

  assert.equal(res.ok, true)
  assert.match((res.ok && res.aftermath?.journeys) ?? '', /^failed:/)
  assert.match(res.ok ? res.message : '', /could not be confirmed stopped/)
})

test('C4: a replay finishes a crew half an earlier pass left behind, and says what it did', async () => {
  const m = await load()
  await seedHold({ status: 'CANCELLED' })
  const e = edge()

  const first = await m.expiry.releaseTruckHoldByOwner({ bookingId: 'bk_life', actor: OWNER }, await releaseDeps(e))
  assert.equal(first.ok && first.outcome, 'already_released')
  assert.equal(first.ok && first.aftermath?.crewCancelled, 2, 'the backlog is finished')
  assert.equal(crew('jc_1').assignmentStatus, 'CANCELLED')
  assert.match(first.ok ? first.message : '', /2 crew assignments were cancelled/)

  // …and running it again changes nothing and claims nothing.
  const second = await m.expiry.releaseTruckHoldByOwner({ bookingId: 'bk_life', actor: OWNER }, await releaseDeps(e))
  assert.equal(second.ok && second.outcome, 'already_released')
  assert.equal(second.ok && second.aftermath?.crewCancelled, 0)
  assert.match(second.ok ? second.message : '', /Nothing was changed/)
})

// ════════════════════════════════════════════════════════════════════════════
//  THE MESSAGE — every sentence has a fact behind it
// ════════════════════════════════════════════════════════════════════════════

test('the release message states only what the halves reported', async () => {
  const m = await load()
  const none = { jobCancelled: false, crewCancelled: 0, journeys: 'ok' }

  const quiet = m.expiry.releaseHoldMessage('released', none, 'not-attempted')
  assert.equal(/crew assignment/.test(quiet), false, 'no crew were cancelled, so none are claimed')
  assert.equal(/checkout session/.test(quiet), false)
  assert.equal(/scheduled emails/.test(quiet), false, 'a silent success is not a claim about the customer\'s inbox')
  assert.match(quiet, /cannot be un-cancelled/, 'the irreversible part is still said')

  const one = m.expiry.releaseHoldMessage('released', { ...none, jobCancelled: true, crewCancelled: 1 }, 'yes')
  assert.match(one, /1 crew assignment was cancelled/, 'singular when it is one')
  assert.match(one, /can no longer be paid/)

  const failed = m.expiry.releaseHoldMessage(
    'released',
    { jobCancelled: false, crewCancelled: 0, jobCancelFailed: 'boom', journeys: 'failed:boom' },
    'unknown',
  )
  assert.match(failed, /could NOT be cancelled/)
  assert.match(failed, /did NOT confirm/)
  assert.equal(/Nothing was changed/.test(failed), false, 'a failure is never "nothing to do"')

  // And no variant may state an outcome for the customer's card.
  for (const msg of [quiet, one, failed, m.expiry.releaseHoldMessage('already_released', none)]) {
    assert.equal(
      /your (?:card|deposit)|the customer'?s card|authorization (?:was|has been) (?:released|voided)|refund(?:ed)? in full/i.test(msg),
      false,
      `no message may state what happened to an authorization: ${msg}`,
    )
  }
})

test('SOURCE GUARD: the release calls the SHARED lifecycle service, not a fourth copy', () => {
  const src = readSrc('src/lib/checkout-expiry.ts')
  const fn = src.slice(src.indexOf('export async function finishCancellationViaLifecycle'))
  assert.match(fn, /await import\('\.\/lifecycle-service'\)/, 'the Job/crew + journey half is the lifecycle service\'s')
  assert.match(fn, /cancelJobForBooking/)
  assert.match(fn, /afterCancellation/)
  // And this module still writes exactly one booking row — the owner's.
  const writes = Array.from(src.matchAll(/booking\.updateMany|booking\.update\b/g))
  assert.equal(writes.length, 1, 'the D1 guarantee: one booking write in this module, inside the human path')
  assert.equal(
    /jobCrew\.updateMany|job\.updateMany/.test(src),
    false,
    'and it does not re-implement the crew cancellation it delegates',
  )
})
