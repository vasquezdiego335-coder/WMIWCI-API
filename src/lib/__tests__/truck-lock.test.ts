// ============================================================================
// Offline tests for the truck double-booking lock (correctness pass item 9).
// No DB: the advisory-lock key derivation is pure, and the in-transaction
// guard runs against a FAKE tx + a fake candidate loader.
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TRUCK_CONFLICT_ACTION,
  TRUCK_CONFLICT_MESSAGE,
  TRUCK_PENDING_CONFLICT_MESSAGE,
  TruckDoubleBookedError,
  assertTruckFreeUnderLock,
  truckConflictResponseBody,
  truckDayLockKey,
  truckDayLockScope,
  type TruckLockTx,
} from '../truck-lock'
import type { TruckBookingShape } from '../truck-conflicts'

const TRUCK = 'truck_box_16'
const OTHER_TRUCK = 'truck_box_26'

// ── Lock key derivation ─────────────────────────────────────────────────────

test('lock key: deterministic — same truck + day always gives the same key', () => {
  const day = new Date('2026-07-04T13:00:00Z')
  assert.equal(truckDayLockKey(TRUCK, day), truckDayLockKey(TRUCK, day))
  assert.equal(truckDayLockKey(TRUCK, day), truckDayLockKey(TRUCK, new Date(day.getTime())))
})

test('lock key: every instant inside the same ET day collides on ONE key', () => {
  // 2026-07-04 in America/New_York (EDT, UTC-4): 04:00Z is midnight ET and
  // 2026-07-05T03:59Z is still 23:59 ET on the 4th.
  const early = truckDayLockKey(TRUCK, new Date('2026-07-04T04:00:00Z'))
  const midday = truckDayLockKey(TRUCK, new Date('2026-07-04T16:30:00Z'))
  const late = truckDayLockKey(TRUCK, new Date('2026-07-05T03:59:00Z'))
  assert.equal(early, midday)
  assert.equal(midday, late)
  // …and a UTC instant that is still the PREVIOUS ET day keys to that day.
  assert.equal(
    truckDayLockKey(TRUCK, new Date('2026-07-04T03:00:00Z')),
    truckDayLockKey(TRUCK, '2026-07-03'),
  )
})

test('lock key: DST — EST and EDT days both key off the ET calendar day', () => {
  // Spring forward 2026-03-08 (EST → EDT at 02:00 ET). 08:00Z is 03:00 EDT.
  assert.equal(
    truckDayLockKey(TRUCK, new Date('2026-03-08T08:00:00Z')),
    truckDayLockKey(TRUCK, '2026-03-08'),
  )
  // 04:00Z on the same date is 23:00 EST on the 7th — a DIFFERENT ET day.
  assert.notEqual(
    truckDayLockKey(TRUCK, new Date('2026-03-08T04:00:00Z')),
    truckDayLockKey(TRUCK, '2026-03-08'),
  )
  // A winter (EST) day and a summer (EDT) day are stable in their own right.
  assert.equal(
    truckDayLockKey(TRUCK, new Date('2026-01-15T12:00:00Z')),
    truckDayLockKey(TRUCK, '2026-01-15'),
  )
})

test('lock key: different truck or different day → different key', () => {
  const day = '2026-07-04'
  assert.notEqual(truckDayLockKey(TRUCK, day), truckDayLockKey(OTHER_TRUCK, day))
  assert.notEqual(truckDayLockKey(TRUCK, day), truckDayLockKey(TRUCK, '2026-07-05'))
})

test('lock key: fits Postgres int8 (pg_advisory_xact_lock takes a signed bigint)', () => {
  const MIN = BigInt('-9223372036854775808')
  const MAX = BigInt('9223372036854775807')
  for (const truck of ['a', 'truck_box_16', 'ckv9z8x0000abcdefghijklm']) {
    for (const day of ['2026-01-01', '2026-07-04', '2027-12-31']) {
      const key = truckDayLockKey(truck, day)
      assert.equal(typeof key, 'bigint')
      assert.ok(key >= MIN && key <= MAX, `${truck}/${day} out of int8 range`)
    }
  }
})

test('lock key: collision-resistant across a realistic truck × day space', () => {
  const keys = new Set<string>()
  let n = 0
  for (let truck = 0; truck < 40; truck++) {
    for (let day = 1; day <= 28; day++) {
      const key = truckDayLockKey(`truck_${truck}`, `2026-06-${String(day).padStart(2, '0')}`)
      keys.add(key.toString())
      n++
    }
  }
  assert.equal(keys.size, n, 'two different (truck, day) pairs shared a lock key')
})

test('lock scope: the documented, inspectable derivation input', () => {
  assert.equal(truckDayLockScope(TRUCK, '2026-07-04'), `moving-os:truck-day:${TRUCK}:2026-07-04`)
  assert.equal(truckDayLockScope(TRUCK, new Date('2026-07-04T16:00:00Z')), `moving-os:truck-day:${TRUCK}:2026-07-04`)
})

// ── The in-transaction guard ────────────────────────────────────────────────

type FakeTx = TruckLockTx & { calls: string[]; lockValues: unknown[] }

function fakeTx(calls: string[]): FakeTx {
  const lockValues: unknown[] = []
  return {
    calls,
    lockValues,
    $queryRaw(query: TemplateStringsArray, ...values: unknown[]) {
      calls.push(`lock:${query.join('?').trim()}`)
      lockValues.push(...values)
      return Promise.resolve([{ pg_advisory_xact_lock: '' }])
    },
  }
}

const booking = (over: Partial<TruckBookingShape> = {}): TruckBookingShape => ({
  id: 'bk_existing',
  displayId: 'WMIC-7001',
  truckId: TRUCK,
  scheduledStart: new Date('2026-07-04T13:00:00Z'), // 9 AM ET
  scheduledEnd: new Date('2026-07-04T18:00:00Z'),
  confirmedDate: null,
  status: 'CONFIRMED',
  ...over,
})

const OPTS = {
  truckId: TRUCK,
  moveDay: new Date('2026-07-04T14:00:00Z'),
  scheduledStart: new Date('2026-07-04T14:00:00Z'), // 10 AM ET — overlaps 9–2
  scheduledEnd: new Date('2026-07-04T19:00:00Z'),
  override: false,
}

test('guard: free truck → no conflicts, and the lock was taken FIRST', async () => {
  const calls: string[] = []
  const tx = fakeTx(calls)
  const conflicts = await assertTruckFreeUnderLock(tx, {
    ...OPTS,
    loadCandidates: async () => {
      calls.push('load')
      return []
    },
  })
  assert.deepEqual(conflicts, [])
  assert.equal(calls.length, 2)
  assert.ok(calls[0].startsWith('lock:'), 'the advisory lock must be acquired before the re-read')
  assert.ok(calls[0].includes('pg_advisory_xact_lock'))
  assert.equal(calls[1], 'load')
  assert.deepEqual(tx.lockValues, [truckDayLockKey(TRUCK, OPTS.moveDay)])
})

test('guard: a booking that landed AFTER the pre-check aborts the transaction', async () => {
  // This is the item-9 race: the pre-check saw a free truck (empty list), the
  // other create committed, and now the loader — running under the lock —
  // sees it.
  const tx = fakeTx([])
  await assert.rejects(
    () => assertTruckFreeUnderLock(tx, { ...OPTS, loadCandidates: async () => [booking()] }),
    (err: unknown) => {
      assert.ok(err instanceof TruckDoubleBookedError)
      assert.equal(err.status, 409)
      // R2-2: the message names the clashing booking and its ET day, and the
      // firm "already booked" wording is reserved for a CONFIRMED job.
      assert.match(err.message, /already booked/i)
      assert.match(err.message, /WMIC-7001/)
      assert.match(err.message, /Jul 4/)
      assert.ok(err.message.endsWith(TRUCK_CONFLICT_ACTION), 'every refusal ends with the same way out')
      assert.equal(err.conflicts.length, 1)
      assert.equal(err.conflicts[0].booking.id, 'bk_existing')
      assert.equal(err.conflicts[0].reason, 'time_overlap')
      assert.equal(err.conflicts[0].hold, 'confirmed')
      return true
    },
  )
})

test('guard: the abort maps to the SAME 409 body the pre-check returns', async () => {
  const tx = fakeTx([])
  const err = await assertTruckFreeUnderLock(tx, {
    ...OPTS,
    truckLabel: 'Truck 1',
    loadCandidates: async () => [booking()],
  }).then(
    () => null,
    (e: unknown) => e,
  )
  assert.ok(err instanceof TruckDoubleBookedError)
  assert.equal(err.truckLabel, 'Truck 1')
  assert.deepEqual(truckConflictResponseBody(err.conflicts, { truckLabel: err.truckLabel }), {
    error: 'Truck 1 is already booked (WMIC-7001) on Jul 4. ' + TRUCK_CONFLICT_ACTION,
    conflicts: [{ bookingId: 'bk_existing', displayId: 'WMIC-7001', reason: 'time_overlap', hold: 'confirmed' }],
  })
  // With no conflicts at all the baseline copy still exists for callers that
  // need a generic sentence.
  assert.equal(truckConflictResponseBody([]).error, TRUCK_CONFLICT_MESSAGE)
})

test('guard: an unpaid hold refuses too — with copy that says WHY (R2-2)', async () => {
  // The default `stripe_link` create writes truckId on a PENDING_PAYMENT row.
  // It holds the truck; the message tells the owner it is not paid for, so the
  // decision to override is an informed one.
  const tx = fakeTx([])
  await assert.rejects(
    () =>
      assertTruckFreeUnderLock(tx, {
        ...OPTS,
        truckLabel: 'Truck 1',
        loadCandidates: async () => [booking({ status: 'PENDING_PAYMENT' })],
      }),
    (err: unknown) => {
      assert.ok(err instanceof TruckDoubleBookedError)
      assert.equal(err.conflicts[0].hold, 'pending')
      assert.equal(err.message, 'Truck 1 is held by an unpaid booking (WMIC-7001) on Jul 4 — not paid or approved yet. ' + TRUCK_CONFLICT_ACTION)
      assert.notEqual(err.message, TRUCK_PENDING_CONFLICT_MESSAGE)
      return true
    },
  )
})

test('guard: an explicit override double-books deliberately and reports it', async () => {
  const tx = fakeTx([])
  const conflicts = await assertTruckFreeUnderLock(tx, {
    ...OPTS,
    override: true,
    loadCandidates: async () => [booking()],
  })
  assert.equal(conflicts.length, 1, 'the override still REPORTS the clash (it is audited)')
  assert.equal(conflicts[0].reason, 'time_overlap')
})

test('guard: a day-level create still holds the whole ET day under the lock', async () => {
  const tx = fakeTx([])
  await assert.rejects(
    () =>
      assertTruckFreeUnderLock(tx, {
        truckId: TRUCK,
        moveDay: new Date('2026-07-04T04:00:00Z'), // 00:00 ET day anchor
        scheduledStart: null,
        scheduledEnd: null,
        override: false,
        loadCandidates: async () => [booking({ scheduledStart: null, scheduledEnd: null, confirmedDate: new Date('2026-07-04T16:00:00Z') })],
      }),
    (err: unknown) => {
      assert.ok(err instanceof TruckDoubleBookedError)
      assert.equal(err.conflicts[0].reason, 'same_day_unknown_times')
      return true
    },
  )
})

// ── P0-A: the lock and the re-check both measure the job's real length ───────

test('P0-A: an evening job locks every ET day its own length reaches', async () => {
  const tx = fakeTx([])
  const start = new Date('2026-07-04T22:00:00Z') // 18:00 EDT
  const conflicts = await assertTruckFreeUnderLock(tx, {
    truckId: TRUCK,
    moveDay: start,
    scheduledStart: start,
    scheduledEnd: null,
    estimatedHours: 8, // a 4BR: 8h + the house travel buffer → 03:00 next day
    override: false,
    loadCandidates: async () => [],
  })
  assert.deepEqual(conflicts, [])
  const expected = [truckDayLockKey(TRUCK, '2026-07-04'), truckDayLockKey(TRUCK, '2026-07-05')].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  assert.deepEqual(tx.lockValues, expected, 'both ET days must be locked, lowest key first')

  // The SAME create with no estimate takes one lock: 18:00 + the flat 6h
  // fallback ends exactly at midnight, and the window is half-open.
  const bare = fakeTx([])
  await assertTruckFreeUnderLock(bare, {
    truckId: TRUCK,
    moveDay: start,
    scheduledStart: start,
    scheduledEnd: null,
    override: false,
    loadCandidates: async () => [],
  })
  assert.deepEqual(bare.lockValues, [truckDayLockKey(TRUCK, '2026-07-04')])
})

test('P0-A: the locked re-check refuses a hold whose STORED row states its length', async () => {
  // The candidate is the row the default `stripe_link` create persists: a move
  // instant, no schedule columns, and estimatedHours. The new booking is the
  // 01:00 create the next morning.
  const eveningHold = booking({
    id: 'bk_evening',
    scheduledStart: null,
    scheduledEnd: null,
    confirmedDate: new Date('2026-07-04T22:00:00Z'), // 18:00 EDT
    status: 'PENDING_PAYMENT',
    estimatedHours: 8,
  })
  const nextMorning = {
    truckId: TRUCK,
    moveDay: new Date('2026-07-05T05:00:00Z'), // 01:00 EDT
    scheduledStart: new Date('2026-07-05T05:00:00Z'),
    scheduledEnd: null,
    estimatedHours: 6,
    override: false,
  }
  await assert.rejects(
    () => assertTruckFreeUnderLock(fakeTx([]), { ...nextMorning, loadCandidates: async () => [eveningHold] }),
    (err: unknown) => {
      assert.ok(err instanceof TruckDoubleBookedError)
      assert.equal(err.conflicts[0].booking.id, 'bk_evening')
      assert.equal(err.conflicts[0].hold, 'pending')
      return true
    },
  )
  // Strip the length off the stored row — the state before P0-A, where the
  // column was selected away — and the guard waves the double-booking through.
  const waved = await assertTruckFreeUnderLock(fakeTx([]), {
    ...nextMorning,
    loadCandidates: async () => [{ ...eveningHold, estimatedHours: null }],
  })
  assert.deepEqual(waved, [], 'the contrast: with no length the hold collapses to the flat fallback')
})

test('guard: another truck on the same day never conflicts (locks do not cross)', async () => {
  const tx = fakeTx([])
  const conflicts = await assertTruckFreeUnderLock(tx, {
    ...OPTS,
    loadCandidates: async () => [booking({ id: 'bk_other', truckId: OTHER_TRUCK })],
  })
  assert.deepEqual(conflicts, [])
  assert.notEqual(truckDayLockKey(TRUCK, OPTS.moveDay), truckDayLockKey(OTHER_TRUCK, OPTS.moveDay))
})

test('guard: a completed/cancelled booking does not hold the truck', async () => {
  const tx = fakeTx([])
  const conflicts = await assertTruckFreeUnderLock(tx, {
    ...OPTS,
    loadCandidates: async () => [booking({ status: 'COMPLETED' }), booking({ id: 'bk_x', status: 'CANCELLED' })],
  })
  assert.deepEqual(conflicts, [])
})
