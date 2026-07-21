// labor-clock.test.ts — the pure clock state machine shared by the admin and
// crew clock routes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildClockUpdate, type ClockRow } from '../labor-clock'

const row = (o: Partial<ClockRow> = {}): ClockRow => ({ assignmentStatus: 'ASSIGNED', clockIn: null, clockOut: null, breakStartedAt: null, actualBreakMinutes: null, ...o })
const T = (h: number) => new Date(`2026-07-22T${String(h).padStart(2, '0')}:00:00Z`)

test('clock in sets clockIn and IN_PROGRESS', () => {
  const r = buildClockUpdate(row(), 'CLOCK_IN', T(8), 'u1')
  assert.ok(r.ok && r.data.clockIn && r.data.assignmentStatus === 'IN_PROGRESS')
})

test('double clock-in is refused 409', () => {
  const r = buildClockUpdate(row({ clockIn: T(8) }), 'CLOCK_IN', T(9), 'u1')
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.status, 409)
})

test('clock out before clock in is refused 422', () => {
  const r = buildClockUpdate(row(), 'CLOCK_OUT', T(17), 'u1')
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.status, 422)
})

test('clock out auto-closes an open break', () => {
  const r = buildClockUpdate(row({ clockIn: T(8), breakStartedAt: T(12), actualBreakMinutes: 0 }), 'CLOCK_OUT', T(17), 'u1')
  assert.ok(r.ok)
  // 12:00 → 17:00 open break = 300 min added, and breakStartedAt cleared.
  assert.equal(r.ok && r.data.actualBreakMinutes, 300)
  assert.equal(r.ok && r.data.breakStartedAt, null)
  assert.equal(r.ok && r.data.assignmentStatus, 'COMPLETED')
})

test('a break cannot start before a clock-in', () => {
  assert.equal(buildClockUpdate(row(), 'BREAK_START', T(12), 'u1').ok, false)
})

test('a second running break is refused', () => {
  const r = buildClockUpdate(row({ clockIn: T(8), breakStartedAt: T(12) }), 'BREAK_START', T(13), 'u1')
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.status, 409)
})

test('break end accumulates minutes and clears the running break', () => {
  const r = buildClockUpdate(row({ clockIn: T(8), breakStartedAt: T(12), actualBreakMinutes: 10 }), 'BREAK_END', new Date('2026-07-22T12:30:00Z'), 'u1')
  assert.ok(r.ok)
  assert.equal(r.ok && r.data.actualBreakMinutes, 40) // 10 existing + 30
  assert.equal(r.ok && r.data.breakStartedAt, null)
})

test('no time can be recorded on a cancelled/declined/no-show assignment', () => {
  for (const s of ['CANCELLED', 'DECLINED', 'NO_SHOW']) {
    assert.equal(buildClockUpdate(row({ assignmentStatus: s }), 'CLOCK_IN', T(8), 'u1').ok, false)
  }
})
