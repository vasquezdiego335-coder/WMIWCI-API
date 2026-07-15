import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  approveBooking,
  checkApprovable,
  type ApprovableBooking,
  type ApprovalDeps,
  type ApprovalStore,
  type CapturedIntent,
  type CommitArgs,
} from '../booking-approval'

// ════════════════════════════════════════════════════════════════════════
//  Offline unit tests for the shared approval service. No prisma, no Stripe,
//  no Redis — the orchestration is exercised through in-memory fakes so we can
//  prove the money-critical invariants (capture exactly once, atomic-claim race
//  safety, rollback on capture failure, idempotent replay) with `node --test`.
// ════════════════════════════════════════════════════════════════════════

function makeBooking(over: Partial<ApprovableBooking> = {}): ApprovableBooking {
  return {
    id: 'bk_1',
    status: 'PENDING_APPROVAL',
    stripePaymentIntentId: 'pi_1',
    depositAmount: 4900,
    displayId: 'WMIC-1001',
    customerToken: 'tok_1',
    itemsDescription: '1 Bedroom move',
    arrivalWindow: '8:00-10:00 AM',
    totalEstimate: 599,
    originAddress: '1 A St, Newark NJ',
    destAddress: '2 B St, Newark NJ',
    serviceAreaZone: 'primary',
    travelFee: 0,
    manualReviewRequired: false,
    requestedDate: new Date('2026-08-01T12:00:00.000Z'),
    confirmedDate: null,
    scheduledStart: null,
    scheduledEnd: null,
    estimatedHours: 3,
    customer: { name: 'Sam Mover', email: 'sam@example.com', phone: '+15555550123', locale: 'en' },
    ...over,
  }
}

type Harness = {
  deps: ApprovalDeps
  state: {
    booking: ApprovableBooking | null
    captures: Array<{ pi: string; key: string }>
    commits: CommitArgs[]
    notifications: Array<{ cents: number; by: string }>
    rollbacks: number
    captureError?: string
    claimForceZero?: boolean
    racedInto?: ApprovableBooking['status']
  }
}

function makeHarness(initial?: ApprovableBooking | null): Harness {
  const state: Harness['state'] = {
    booking: initial === undefined ? makeBooking() : initial,
    captures: [],
    commits: [],
    notifications: [],
    rollbacks: 0,
  }

  const store: ApprovalStore = {
    async loadBooking() {
      return state.booking ? { ...state.booking } : null
    },
    async claimConfirm(_id, sched) {
      if (state.claimForceZero) {
        // Simulate losing the race: another actor moved the row underneath us.
        if (state.racedInto && state.booking) state.booking = { ...state.booking, status: state.racedInto }
        return 0
      }
      if (state.booking && state.booking.status === 'PENDING_APPROVAL') {
        state.booking = { ...state.booking, status: 'CONFIRMED', ...(sched ?? {}) }
        return 1
      }
      return 0
    },
    async rollbackClaim(_id) {
      state.rollbacks++
      if (state.booking) state.booking = { ...state.booking, status: 'PENDING_APPROVAL' }
    },
    async reloadStatus() {
      return state.booking ? { ...state.booking } : null
    },
    async commitApproval(args) {
      state.commits.push(args)
    },
  }

  const deps: ApprovalDeps = {
    store,
    stripe: {
      async capture(pi, key) {
        state.captures.push({ pi, key })
        if (state.captureError) throw new Error(state.captureError)
        const intent: CapturedIntent = { id: pi, amount_received: 4900, latest_charge: 'ch_1', metadata: {} }
        return intent
      },
      async retrieveCharge() {
        return { id: 'ch_1', receipt_url: 'https://receipt.example/ch_1', payment_method_details: { type: 'card' } }
      },
    },
    notifier: {
      async sendApproved(_booking, cents, by) {
        state.notifications.push({ cents, by })
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  }

  return { deps, state }
}

// ── Pure guard ────────────────────────────────────────────────────────────────

test('checkApprovable: PENDING_APPROVAL with a payment intent is approvable', () => {
  assert.deepEqual(checkApprovable('PENDING_APPROVAL', true), { ok: true })
})

test('checkApprovable: wrong status is rejected', () => {
  const r = checkApprovable('SCHEDULED', true)
  assert.equal(r.ok, false)
  assert.equal((r as { code: string }).code, 'invalid_status')
})

test('checkApprovable: missing payment intent is rejected', () => {
  const r = checkApprovable('PENDING_APPROVAL', false)
  assert.equal(r.ok, false)
  assert.equal((r as { code: string }).code, 'no_payment_intent')
})

// ── Admin approval happy path (the reported bug) ──────────────────────────────

test('admin approval captures the authorization exactly once and records it', async () => {
  const h = makeHarness()
  const res = await approveBooking(
    { bookingId: 'bk_1', actor: { name: 'Diego', userId: 'u_diego', role: 'OWNER' }, source: 'admin' },
    h.deps,
  )
  assert.equal(res.ok, true)
  assert.equal((res as { outcome: string }).outcome, 'captured')
  assert.equal(h.state.captures.length, 1)
  assert.equal(h.state.captures[0].key, 'capture:pi_1') // idempotency key
  assert.equal(h.state.commits.length, 1)
  assert.equal(h.state.commits[0].capturedCents, 4900)
  assert.equal(h.state.commits[0].auditDetails.source, 'admin')
  assert.equal(h.state.commits[0].paymentMeta.capturedBy, 'Diego')
})

test('discord approval uses the SAME service and captures once', async () => {
  const h = makeHarness()
  const res = await approveBooking(
    { discordMessageId: 'msg_1', actor: { name: 'Sebastian', discordUserId: 'd_seb', role: 'OWNER' }, source: 'discord' },
    h.deps,
  )
  assert.equal(res.ok, true)
  assert.equal(h.state.captures.length, 1)
  assert.equal(h.state.commits[0].auditDetails.source, 'discord')
  assert.equal(h.state.commits[0].auditDetails.discordUserId, 'd_seb')
  // Discord actor has no real User id → audit userId stays null (no bad FK).
  assert.equal(h.state.commits[0].auditUserId, null)
})

// ── Idempotency + concurrency (no double capture) ─────────────────────────────

test('a second approval of an already-CONFIRMED booking does NOT capture again', async () => {
  const h = makeHarness()
  await approveBooking({ bookingId: 'bk_1', actor: { name: 'Diego', role: 'OWNER' }, source: 'admin' }, h.deps)
  const second = await approveBooking({ bookingId: 'bk_1', actor: { name: 'Diego', role: 'OWNER' }, source: 'admin' }, h.deps)
  assert.equal(second.ok, true)
  assert.equal((second as { outcome: string }).outcome, 'already_confirmed')
  assert.equal(h.state.captures.length, 1) // still just one capture
})

test('lost the atomic claim (already CONFIRMED elsewhere) → already_confirmed, no capture', async () => {
  const h = makeHarness(makeBooking({ status: 'PENDING_APPROVAL' }))
  h.state.claimForceZero = true
  h.state.racedInto = 'CONFIRMED'
  const res = await approveBooking({ bookingId: 'bk_1', actor: { name: 'Diego', role: 'OWNER' }, source: 'admin' }, h.deps)
  assert.equal(res.ok, true)
  assert.equal((res as { outcome: string }).outcome, 'already_confirmed')
  assert.equal(h.state.captures.length, 0)
})

test('lost the claim to a non-confirmed state → raced error, no capture', async () => {
  const h = makeHarness(makeBooking({ status: 'PENDING_APPROVAL' }))
  h.state.claimForceZero = true
  h.state.racedInto = 'CANCELLED'
  const res = await approveBooking({ bookingId: 'bk_1', actor: { name: 'Diego', role: 'OWNER' }, source: 'admin' }, h.deps)
  assert.equal(res.ok, false)
  assert.equal((res as { code: string }).code, 'raced')
  assert.equal(h.state.captures.length, 0)
})

test('two simultaneous approvals capture exactly once (Promise.all)', async () => {
  const h = makeHarness()
  const [a, b] = await Promise.all([
    approveBooking({ bookingId: 'bk_1', actor: { name: 'Diego', role: 'OWNER' }, source: 'admin' }, h.deps),
    approveBooking({ discordMessageId: 'msg_1', actor: { name: 'Sebastian', role: 'OWNER' }, source: 'discord' }, h.deps),
  ])
  assert.equal(a.ok && b.ok, true)
  assert.equal(h.state.captures.length, 1) // only ONE capture across both surfaces
  assert.equal(h.state.commits.length, 1)
  const outcomes = [a, b].map((r) => (r as { outcome: string }).outcome).sort()
  assert.deepEqual(outcomes, ['already_confirmed', 'captured'])
})

// ── Failure handling (Stripe error must NOT falsely confirm) ──────────────────

test('capture failure rolls the claim back and does NOT record a payment', async () => {
  const h = makeHarness()
  h.state.captureError = 'authorization has expired'
  const res = await approveBooking({ bookingId: 'bk_1', actor: { name: 'Diego', role: 'OWNER' }, source: 'admin' }, h.deps)
  assert.equal(res.ok, false)
  assert.equal((res as { code: string }).code, 'capture_failed')
  assert.match((res as { message: string }).message, /expired/)
  assert.equal(h.state.rollbacks, 1)
  assert.equal(h.state.commits.length, 0) // no payment recorded
  assert.equal(h.state.booking?.status, 'PENDING_APPROVAL') // rolled back
})

test('missing payment intent → clear error, no capture', async () => {
  const h = makeHarness(makeBooking({ stripePaymentIntentId: null }))
  const res = await approveBooking({ bookingId: 'bk_1', actor: { name: 'Diego', role: 'OWNER' }, source: 'admin' }, h.deps)
  assert.equal(res.ok, false)
  assert.equal((res as { code: string }).code, 'no_payment_intent')
  assert.equal(h.state.captures.length, 0)
})

test('not found → not_found error', async () => {
  const h = makeHarness(null)
  const res = await approveBooking({ bookingId: 'nope', actor: { name: 'Diego', role: 'OWNER' }, source: 'admin' }, h.deps)
  assert.equal(res.ok, false)
  assert.equal((res as { code: string }).code, 'not_found')
})

// ── Authorization ─────────────────────────────────────────────────────────────

test('CREW cannot approve (forbidden), no capture', async () => {
  const h = makeHarness()
  const res = await approveBooking({ bookingId: 'bk_1', actor: { name: 'Cory Crew', role: 'CREW' }, source: 'admin' }, h.deps)
  assert.equal(res.ok, false)
  assert.equal((res as { code: string }).code, 'forbidden')
  assert.equal(h.state.captures.length, 0)
})

test('MANAGER is allowed to approve (operations authority)', async () => {
  const h = makeHarness()
  const res = await approveBooking({ bookingId: 'bk_1', actor: { name: 'Mia Manager', role: 'MANAGER' }, source: 'admin' }, h.deps)
  assert.equal(res.ok, true)
  assert.equal(h.state.captures.length, 1)
})

// ── Notifications happen after truth, never before, and never block ──────────

test('notification fires after commit with the captured amount', async () => {
  const h = makeHarness()
  await approveBooking({ bookingId: 'bk_1', actor: { name: 'Diego', role: 'OWNER' }, source: 'admin' }, h.deps)
  assert.equal(h.state.notifications.length, 1)
  assert.equal(h.state.notifications[0].cents, 4900)
})

test('notify:false skips customer messaging (still captures + records)', async () => {
  const h = makeHarness()
  const res = await approveBooking(
    { bookingId: 'bk_1', actor: { name: 'Diego', role: 'OWNER' }, source: 'admin', notify: false },
    h.deps,
  )
  assert.equal(res.ok, true)
  assert.equal(h.state.notifications.length, 0)
  assert.equal(h.state.commits.length, 1)
})

test('a notification failure does NOT undo the capture', async () => {
  const h = makeHarness()
  h.deps.notifier.sendApproved = async () => {
    throw new Error('redis down')
  }
  const res = await approveBooking({ bookingId: 'bk_1', actor: { name: 'Diego', role: 'OWNER' }, source: 'admin' }, h.deps)
  assert.equal(res.ok, true)
  assert.equal((res as { outcome: string }).outcome, 'captured')
  assert.equal(h.state.commits.length, 1) // payment still recorded
})
