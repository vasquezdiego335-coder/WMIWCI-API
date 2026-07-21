// availability-engine.test.ts — the precedence is the part that must never be
// wrong, so it is what these tests pin.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateAvailability, availableBlocksForDate, dayOfWeekOf, overlaps,
  parseHHMM, formatMinute, type RecurringRule, type DateException,
} from '../availability-engine'

// 2026-07-22 is a Wednesday (dayOfWeek 3).
const WED = '2026-07-22'
const mon9to5: RecurringRule = { dayOfWeek: 3, startMinute: 8 * 60, endMinute: 17 * 60 }
const window = (startMinute: number, endMinute: number, date = WED) => ({ date, startMinute, endMinute })

test('day of week is timezone-independent', () => {
  assert.equal(dayOfWeekOf('2026-07-22'), 3) // Wed
  assert.equal(dayOfWeekOf('2026-07-19'), 0) // Sun
})

test('overlap is closed-open', () => {
  assert.equal(overlaps(0, 10, 10, 20), false) // touching, not overlapping
  assert.equal(overlaps(0, 11, 10, 20), true)
})

test('within recurring availability → available', () => {
  const d = evaluateAvailability({ window: window(9 * 60, 12 * 60), rules: [mon9to5], exceptions: [] })
  assert.equal(d.available, true)
  assert.equal(d.tier, 'RECURRING')
})

test('a window not fully covered by a rule is NOT available', () => {
  const d = evaluateAvailability({ window: window(7 * 60, 12 * 60), rules: [mon9to5], exceptions: [] })
  assert.equal(d.available, false)
  assert.equal(d.tier, 'DEFAULT_UNAVAILABLE')
})

test('multiple blocks in one day — a later block covers a later window', () => {
  const rules: RecurringRule[] = [
    { dayOfWeek: 3, startMinute: 8 * 60, endMinute: 11 * 60 },
    { dayOfWeek: 3, startMinute: 14 * 60, endMinute: 18 * 60 },
  ]
  assert.equal(evaluateAvailability({ window: window(15 * 60, 17 * 60), rules, exceptions: [] }).available, true)
  // The gap between the two blocks is not available.
  assert.equal(evaluateAvailability({ window: window(12 * 60, 13 * 60), rules, exceptions: [] }).available, false)
})

test('default is UNAVAILABLE — nothing configured means no', () => {
  const d = evaluateAvailability({ window: window(9 * 60, 12 * 60), rules: [], exceptions: [] })
  assert.equal(d.available, false)
  assert.equal(d.tier, 'DEFAULT_UNAVAILABLE')
})

// ── Precedence, top to bottom ───────────────────────────────────────────────

test('PRECEDENCE 1: an admin block beats everything, and is a hard block', () => {
  const exceptions: DateException[] = [{ kind: 'ADMIN_BLOCK', date: WED }]
  const d = evaluateAvailability({ window: window(9 * 60, 12 * 60), rules: [mon9to5], exceptions })
  assert.equal(d.available, false)
  assert.equal(d.tier, 'ADMIN_BLOCK')
  assert.equal(d.hardBlock, true)
})

test('PRECEDENCE 1: a business-wide closed day is the same top tier', () => {
  const d = evaluateAvailability({ window: window(9 * 60, 12 * 60), rules: [mon9to5], exceptions: [], businessBlocked: true })
  assert.equal(d.available, false)
  assert.equal(d.hardBlock, true)
})

test('PRECEDENCE 2: a date UNAVAILABLE_FULL beats a recurring rule', () => {
  const exceptions: DateException[] = [{ kind: 'UNAVAILABLE_FULL', date: WED }]
  const d = evaluateAvailability({ window: window(9 * 60, 12 * 60), rules: [mon9to5], exceptions })
  assert.equal(d.available, false)
  assert.equal(d.tier, 'DATE_UNAVAILABLE')
  assert.equal(d.hardBlock, false) // overridable, unlike an admin block
})

test('PRECEDENCE 2: LEAVE and VACATION are date-unavailable', () => {
  for (const kind of ['LEAVE', 'VACATION'] as const) {
    const d = evaluateAvailability({ window: window(9 * 60, 12 * 60), rules: [mon9to5], exceptions: [{ kind, date: WED }] })
    assert.equal(d.available, false, kind)
    assert.equal(d.tier, 'DATE_UNAVAILABLE')
  }
})

test('PRECEDENCE 2: a partial-unavailable window blocks only an overlapping request', () => {
  const exceptions: DateException[] = [{ kind: 'UNAVAILABLE_PARTIAL', date: WED, startMinute: 12 * 60, endMinute: 13 * 60 }]
  // Overlaps the lunch block → unavailable.
  assert.equal(evaluateAvailability({ window: window(11 * 60, 13 * 60), rules: [mon9to5], exceptions }).available, false)
  // Does not overlap → still available from the recurring rule.
  assert.equal(evaluateAvailability({ window: window(9 * 60, 11 * 60), rules: [mon9to5], exceptions }).available, true)
})

test('PRECEDENCE 3: an available-override beats the absence of a recurring rule', () => {
  const exceptions: DateException[] = [{ kind: 'AVAILABLE_OVERRIDE', date: WED, startMinute: 6 * 60, endMinute: 20 * 60 }]
  const d = evaluateAvailability({ window: window(6 * 60, 8 * 60), rules: [], exceptions })
  assert.equal(d.available, true)
  assert.equal(d.tier, 'DATE_AVAILABLE_OVERRIDE')
})

test('PRECEDENCE 3: a date-unavailable still beats an available-override (order matters)', () => {
  const exceptions: DateException[] = [
    { kind: 'UNAVAILABLE_FULL', date: WED },
    { kind: 'AVAILABLE_OVERRIDE', date: WED, startMinute: 0, endMinute: 24 * 60 },
  ]
  assert.equal(evaluateAvailability({ window: window(9 * 60, 12 * 60), rules: [], exceptions }).available, false)
})

test('effective date range gates a recurring rule', () => {
  const dated: RecurringRule = { ...mon9to5, effectiveFrom: '2026-08-01' }
  // Before the effective date the rule does not apply.
  assert.equal(evaluateAvailability({ window: window(9 * 60, 12 * 60), rules: [dated], exceptions: [] }).available, false)
  // On/after it does.
  assert.equal(evaluateAvailability({ window: { date: '2026-08-05', startMinute: 9 * 60, endMinute: 12 * 60 }, rules: [{ ...mon9to5, dayOfWeek: 3, effectiveFrom: '2026-08-01' }], exceptions: [] }).available, true)
})

test('an inactive rule is ignored', () => {
  assert.equal(evaluateAvailability({ window: window(9 * 60, 12 * 60), rules: [{ ...mon9to5, active: false }], exceptions: [] }).available, false)
})

// ── Day-block read model ────────────────────────────────────────────────────

test('availableBlocksForDate merges rules and subtracts partial-unavailable', () => {
  const blocks = availableBlocksForDate({
    date: WED,
    rules: [mon9to5],
    exceptions: [{ kind: 'UNAVAILABLE_PARTIAL', date: WED, startMinute: 12 * 60, endMinute: 13 * 60 }],
  })
  // 8–17 minus 12–13 → 8–12 and 13–17.
  assert.equal(blocks.length, 2)
  assert.deepEqual([blocks[0].startMinute, blocks[0].endMinute], [8 * 60, 12 * 60])
  assert.deepEqual([blocks[1].startMinute, blocks[1].endMinute], [13 * 60, 17 * 60])
})

test('availableBlocksForDate is empty on a full day off', () => {
  assert.equal(availableBlocksForDate({ date: WED, rules: [mon9to5], exceptions: [{ kind: 'VACATION', date: WED }] }).length, 0)
})

// ── Parsing + formatting ────────────────────────────────────────────────────

test('parseHHMM rejects malformed input rather than reading midnight', () => {
  assert.equal(parseHHMM('08:30'), 510)
  assert.equal(parseHHMM('24:00'), null)
  assert.equal(parseHHMM('8'), null)
  assert.equal(parseHHMM(''), null)
})

test('formatMinute is 12-hour', () => {
  assert.equal(formatMinute(510), '8:30 AM')
  assert.equal(formatMinute(13 * 60), '1:00 PM')
  assert.equal(formatMinute(0), '12:00 AM')
})
