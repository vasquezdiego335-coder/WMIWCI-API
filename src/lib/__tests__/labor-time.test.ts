// Phase 1 — time math + validation. Integer minutes, never Float hours.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeTimeBreakdown,
  validateTimeEntry,
  hasBlockingIssue,
  hasReviewIssue,
  minutesBetween,
  minutesToHours,
  hoursToMinutes,
  formatMinutes,
  isClockedIn,
  isOnBreak,
  DEFAULT_TIME_POLICY,
} from '../labor-time'

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 6, 20, h, m, 0))

test('the worked example: 8:00-17:00 with a 30m break = 8.5 paid hours', () => {
  const b = computeTimeBreakdown({ clockIn: at(8), clockOut: at(17), breakMinutes: 30 })
  assert.equal(b.elapsedMinutes, 540)
  assert.equal(b.breakMinutes, 30)
  assert.equal(b.workedMinutes, 510)
  assert.equal(minutesToHours(b.paidMinutes), 8.5)
})

test('minutes helpers round-trip and format', () => {
  assert.equal(minutesBetween(at(8), at(17)), 540)
  assert.equal(hoursToMinutes(8.5), 510)
  assert.equal(minutesToHours(510), 8.5)
  assert.equal(formatMinutes(510), '8h 30m')
  assert.equal(formatMinutes(45), '45m')
  assert.equal(formatMinutes(480), '8h')
  assert.equal(formatMinutes(null), '0m')
})

test('overtime splits at the policy threshold', () => {
  // 10h worked, 8h threshold => 8h regular + 2h overtime.
  const b = computeTimeBreakdown({ clockIn: at(7), clockOut: at(17) })
  assert.equal(b.workedMinutes, 600)
  assert.equal(b.regularMinutes, 480)
  assert.equal(b.overtimeMinutes, 120)
  assert.equal(b.paidMinutes, 600)
})

test('a zero overtime threshold disables overtime entirely', () => {
  const b = computeTimeBreakdown({ clockIn: at(7), clockOut: at(19) }, { overtimeThresholdMinutes: 0, longShiftReviewMinutes: 840 })
  assert.equal(b.overtimeMinutes, 0)
  assert.equal(b.regularMinutes, 720)
})

test('manual entry states WORKED time; breaks are added to elapsed, not deducted twice', () => {
  const b = computeTimeBreakdown({ workedMinutesOverride: 480, breakMinutes: 30 })
  assert.equal(b.workedMinutes, 480) // not 450
  assert.equal(b.elapsedMinutes, 510)
})

test('travel REGULAR is paid once, in paidMinutes only', () => {
  const b = computeTimeBreakdown({ clockIn: at(9), clockOut: at(17), travelMinutes: 60, travelPayPolicy: 'REGULAR' })
  assert.equal(b.travelMinutes, 60)
  assert.equal(b.travelPaidAtRegular, 60)
  assert.equal(b.travelPaidSeparately, 0)
  assert.equal(b.paidMinutes, b.regularMinutes + b.overtimeMinutes + 60)
})

test('travel SEPARATE_RATE is excluded from paidMinutes so it cannot be paid twice', () => {
  const b = computeTimeBreakdown({ clockIn: at(9), clockOut: at(17), travelMinutes: 60, travelPayPolicy: 'SEPARATE_RATE' })
  assert.equal(b.travelPaidSeparately, 60)
  assert.equal(b.travelPaidAtRegular, 0)
  assert.equal(b.paidMinutes, b.regularMinutes + b.overtimeMinutes)
})

test('travel UNPAID is recorded but never paid', () => {
  const b = computeTimeBreakdown({ clockIn: at(9), clockOut: at(17), travelMinutes: 90, travelPayPolicy: 'UNPAID' })
  assert.equal(b.travelMinutes, 90)
  assert.equal(b.travelPaidAtRegular, 0)
  assert.equal(b.travelPaidSeparately, 0)
  assert.equal(b.paidMinutes, 480)
})

// ── Validation ──────────────────────────────────────────────────────────────

test('clock-out before clock-in is an ERROR', () => {
  const issues = validateTimeEntry({ clockIn: at(17), clockOut: at(8), now: at(20) })
  assert.ok(hasBlockingIssue(issues))
  assert.ok(issues.some((i) => i.code === 'clock_out_before_in'))
})

test('clock-out without clock-in is an ERROR', () => {
  const issues = validateTimeEntry({ clockOut: at(17), now: at(20) })
  assert.ok(issues.some((i) => i.code === 'clock_out_without_in' && i.level === 'ERROR'))
})

test('a future timestamp is an ERROR', () => {
  const issues = validateTimeEntry({ clockIn: at(23), now: at(9) })
  assert.ok(issues.some((i) => i.code === 'future_timestamp' && i.level === 'ERROR'))
})

test('a break longer than the shift is an ERROR', () => {
  const issues = validateTimeEntry({ clockIn: at(9), clockOut: at(10), breakMinutes: 120, now: at(20) })
  assert.ok(issues.some((i) => i.code === 'break_exceeds_shift' && i.level === 'ERROR'))
})

test('negative time is an ERROR', () => {
  assert.ok(validateTimeEntry({ breakMinutes: -5 }).some((i) => i.code === 'negative_break'))
  assert.ok(validateTimeEntry({ workedMinutesOverride: -60 }).some((i) => i.code === 'negative_hours'))
  assert.ok(validateTimeEntry({ travelMinutes: -10 }).some((i) => i.code === 'negative_travel'))
})

test('time with no rate is an ERROR — free labor is never assumed', () => {
  const issues = validateTimeEntry({ clockIn: at(9), clockOut: at(17), hasRate: false, now: at(20) })
  assert.ok(issues.some((i) => i.code === 'missing_rate' && i.level === 'ERROR'))
})

test('a LONG shift is a WARNING, not a rejection — long move days are real', () => {
  const issues = validateTimeEntry({ clockIn: at(5), clockOut: at(23), now: new Date(Date.UTC(2026, 6, 21)) })
  assert.equal(hasBlockingIssue(issues), false)
  assert.ok(hasReviewIssue(issues))
  assert.ok(issues.some((i) => i.code === 'long_shift'))
})

test('a missing clock-out is a WARNING while the shift is still open', () => {
  const issues = validateTimeEntry({ clockIn: at(9), now: at(12) })
  assert.equal(hasBlockingIssue(issues), false)
  assert.ok(issues.some((i) => i.code === 'missing_clock_out' && i.level === 'WARNING'))
})

test('overlapping shifts for the same worker are flagged', () => {
  const issues = validateTimeEntry({
    clockIn: at(9),
    clockOut: at(17),
    now: at(20),
    otherShifts: [{ start: at(13), end: at(19), label: 'WMIC-1042' }],
  })
  assert.ok(issues.some((i) => i.code === 'overlapping_shift'))
})

test('non-overlapping shifts are NOT flagged', () => {
  const issues = validateTimeEntry({
    clockIn: at(9),
    clockOut: at(12),
    now: at(20),
    otherShifts: [{ start: at(13), end: at(19) }],
  })
  assert.equal(issues.some((i) => i.code === 'overlapping_shift'), false)
})

test('travel longer than the work is flagged for review, not rejected', () => {
  const issues = validateTimeEntry({ clockIn: at(9), clockOut: at(10), travelMinutes: 180, now: at(20) })
  assert.equal(hasBlockingIssue(issues), false)
  assert.ok(issues.some((i) => i.code === 'travel_exceeds_work'))
})

test('a cancelled assignment cannot take time', () => {
  const issues = validateTimeEntry({ clockIn: at(9), clockOut: at(17), assignmentStatus: 'CANCELLED', now: at(20) })
  assert.ok(issues.some((i) => i.code === 'assignment_cancelled' && i.level === 'ERROR'))
})

test('a worker not assigned to the move cannot take time', () => {
  assert.ok(validateTimeEntry({ isAssigned: false }).some((i) => i.code === 'not_assigned'))
})

test('errors sort before warnings', () => {
  const issues = validateTimeEntry({ clockIn: at(17), clockOut: at(8), breakMinutes: -1, now: at(20) })
  assert.equal(issues[0].level, 'ERROR')
})

test('clock state helpers', () => {
  assert.equal(isClockedIn({ clockIn: at(9), clockOut: null }), true)
  assert.equal(isClockedIn({ clockIn: at(9), clockOut: at(17) }), false)
  assert.equal(isOnBreak({ breakStartedAt: at(12), clockOut: null }), true)
  assert.equal(isOnBreak({ breakStartedAt: at(12), clockOut: at(17) }), false)
})

test('the default policy is 8h overtime / 14h review', () => {
  assert.equal(DEFAULT_TIME_POLICY.overtimeThresholdMinutes, 480)
  assert.equal(DEFAULT_TIME_POLICY.longShiftReviewMinutes, 840)
})
