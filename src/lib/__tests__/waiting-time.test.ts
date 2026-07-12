// Offline tests for the Late Arrival & Delay Policy calculator (single source
// of truth for the fee math). Pure functions — no DB, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeWaitingFee,
  waitingMinutesBetween,
  resolveWaiting,
  effectiveWaitingFeeCents,
  feeDollars,
  WAITING_GRACE_MINUTES,
  WAITING_BLOCK_FEE_CENTS,
} from '../waiting-time'

test('waiting: first 30 minutes are always free', () => {
  for (const m of [0, 1, 15, 29, 30]) {
    assert.equal(computeWaitingFee(m).feeCents, 0, `${m} min should be free`)
    assert.equal(computeWaitingFee(m).billableMinutes, 0)
  }
})

test('waiting: $50 per additional 30-minute block, portion rounds up', () => {
  assert.equal(computeWaitingFee(31).feeCents, 5000) // 1 min into block 1 → $50
  assert.equal(computeWaitingFee(45).feeCents, 5000)
  assert.equal(computeWaitingFee(60).feeCents, 5000) // exactly 30 billable → $50
  assert.equal(computeWaitingFee(61).feeCents, 10000) // into block 2 → $100
  assert.equal(computeWaitingFee(90).feeCents, 10000) // 60 billable → $100
  assert.equal(computeWaitingFee(91).feeCents, 15000) // → $150
  assert.equal(computeWaitingFee(120).feeCents, 15000)
})

test('waiting: receipt example — 90 min total = 60 billable = $100', () => {
  const r = computeWaitingFee(90)
  assert.equal(r.billableMinutes, 60)
  assert.equal(r.feeCents, 10000)
  assert.equal(feeDollars(r.feeCents), '$100')
})

test('waiting: 90-minute reschedule threshold', () => {
  assert.equal(computeWaitingFee(90).exceedsRescheduleThreshold, false)
  assert.equal(computeWaitingFee(91).exceedsRescheduleThreshold, true)
})

test('waiting: negative / garbage minutes never produce a fee', () => {
  assert.equal(computeWaitingFee(-10).feeCents, 0)
  assert.equal(computeWaitingFee(NaN as unknown as number).feeCents, 0)
})

test('waitingMinutesBetween: clamps at zero and rounds to minutes', () => {
  const a = new Date('2026-07-12T10:00:00Z')
  const b = new Date('2026-07-12T11:05:00Z')
  assert.equal(waitingMinutesBetween(a, b), 65)
  assert.equal(waitingMinutesBetween(b, a), 0) // end before start → 0
  assert.equal(waitingMinutesBetween(null, b), 0)
})

test('resolveWaiting: explicit window beats arrival window', () => {
  const r = resolveWaiting({
    crewArrivedAt: new Date('2026-07-12T10:00:00Z'),
    customerReadyAt: new Date('2026-07-12T12:00:00Z'), // 120 via arrival
    waitingStartedAt: new Date('2026-07-12T10:30:00Z'),
    waitingEndedAt: new Date('2026-07-12T11:30:00Z'), // 60 via explicit
  })
  assert.equal(r.source, 'explicit')
  assert.equal(r.totalMinutes, 60)
  assert.equal(r.feeCents, 5000)
  assert.equal(r.ongoing, false)
})

test('resolveWaiting: Customer Ready also closes an open waiting window', () => {
  const r = resolveWaiting({
    waitingStartedAt: new Date('2026-07-12T10:00:00Z'),
    customerReadyAt: new Date('2026-07-12T11:00:00Z'),
  })
  assert.equal(r.source, 'explicit')
  assert.equal(r.ongoing, false)
  assert.equal(r.totalMinutes, 60)
})

test('resolveWaiting: no timestamps → nothing owed', () => {
  const r = resolveWaiting({})
  assert.equal(r.source, 'none')
  assert.equal(r.feeCents, 0)
})

test('effectiveWaitingFeeCents: waiver zeroes, override wins, else derived', () => {
  assert.equal(effectiveWaitingFeeCents({ waitingFee: 10000, waitingFeeWaived: true }), 0)
  assert.equal(effectiveWaitingFeeCents({ waitingFee: 10000, waitingFeeOverride: 2500 }), 2500)
  assert.equal(effectiveWaitingFeeCents({ waitingFee: 10000 }), 10000)
  assert.equal(effectiveWaitingFeeCents({}), 0)
})

test('waiting: policy constants match the owner spec', () => {
  assert.equal(WAITING_GRACE_MINUTES, 30)
  assert.equal(WAITING_BLOCK_FEE_CENTS, 5000)
})
