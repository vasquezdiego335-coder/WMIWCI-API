// Stage 3 — reporting period math (time zone / DST) and basis rules
// (finalized vs provisional, cash vs accrual).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolvePeriod, previousComparablePeriod, compareCents, zonedParts,
  zonedStartOfDay, startOfBusinessWeek, addBusinessDays, inPeriod,
  formatBusinessDate, inclusiveEndDate, BUSINESS_TIME_ZONE,
} from '../reporting-period'
import {
  describeBasis, aggregateMoves, selectMoveFigures, revenueForBasis, isMixedSource,
  type MoveFinancialRow,
} from '../reporting-basis'

// ── Time zone ───────────────────────────────────────────────────────────────

test('the business time zone is America/New_York', () => {
  assert.equal(BUSINESS_TIME_ZONE, 'America/New_York')
})

test('REGRESSION: a late-evening move stays in ITS month, not the UTC month', () => {
  // 31 Jan 2026, 8pm ET = 1 Feb 2026 01:00 UTC. Using UTC boundaries would move
  // this move's revenue into February and the owner would never know why.
  const lateJan = new Date('2026-02-01T01:00:00Z')
  const jan = resolvePeriod('this_month', lateJan)
  assert.equal(jan.label, 'January 2026')
  assert.equal(inPeriod(lateJan, jan), true)
  const feb = resolvePeriod('this_month', new Date('2026-02-05T17:00:00Z'))
  assert.equal(inPeriod(lateJan, feb), false)
})

test('month boundaries are business-local midnight, exclusive at the end', () => {
  const p = resolvePeriod('this_month', new Date('2026-03-15T16:00:00Z'))
  assert.equal(p.label, 'March 2026')
  // 1 Mar 2026 00:00 ET = 05:00 UTC (EST, UTC-5)
  assert.equal(p.start.toISOString(), '2026-03-01T05:00:00.000Z')
  // 1 Apr 2026 00:00 ET = 04:00 UTC (EDT, UTC-4) — the offset CHANGED mid-month
  assert.equal(p.end.toISOString(), '2026-04-01T04:00:00.000Z')
})

test('DST spring-forward: 8 March 2026 is 23 hours, and boundaries stay midnight', () => {
  const before = zonedStartOfDay(2026, 3, 8) // EST
  const after = zonedStartOfDay(2026, 3, 9) // EDT
  const hours = (after.getTime() - before.getTime()) / 3_600_000
  assert.equal(hours, 23)
  assert.equal(zonedParts(before).hour, 0)
  assert.equal(zonedParts(after).hour, 0)
})

test('DST fall-back: 1 November 2026 is 25 hours', () => {
  const before = zonedStartOfDay(2026, 11, 1)
  const after = zonedStartOfDay(2026, 11, 2)
  assert.equal((after.getTime() - before.getTime()) / 3_600_000, 25)
})

test('addBusinessDays crosses DST without drifting off midnight', () => {
  const d = addBusinessDays(zonedStartOfDay(2026, 3, 7), 3)
  assert.equal(zonedParts(d).day, 10)
  assert.equal(zonedParts(d).hour, 0)
})

test('the week starts on Monday in business-local time', () => {
  // Wednesday 18 March 2026
  const w = startOfBusinessWeek(new Date('2026-03-18T18:00:00Z'))
  const p = zonedParts(w)
  assert.equal(p.day, 16) // Monday
  assert.equal(p.hour, 0)
})

test('year boundary: 31 Dec 8pm ET belongs to the old year', () => {
  const nye = new Date('2027-01-01T01:00:00Z') // 31 Dec 2026, 8pm ET
  const ytd = resolvePeriod('year_to_date', nye)
  assert.equal(ytd.label, '2026 year to date')
  assert.equal(inPeriod(nye, ytd), true)
})

test('quarters resolve correctly', () => {
  assert.equal(resolvePeriod('this_quarter', new Date('2026-05-10T16:00:00Z')).label, 'Q2 2026')
  assert.equal(resolvePeriod('previous_quarter', new Date('2026-05-10T16:00:00Z')).label, 'Q1 2026')
  // January rolls back to Q4 of the prior year.
  assert.equal(resolvePeriod('previous_quarter', new Date('2026-01-10T16:00:00Z')).label, 'Q4 2025')
})

test('previous_month rolls the year back in January', () => {
  assert.equal(resolvePeriod('previous_month', new Date('2026-01-15T16:00:00Z')).label, 'December 2025')
})

test('a custom range treats the end date as INCLUSIVE for the user', () => {
  const p = resolvePeriod('custom', new Date('2026-06-15T12:00:00Z'), { start: '2026-06-01', end: '2026-06-30' })
  // A move at 11:59pm ET on 30 June must be inside.
  assert.equal(inPeriod(new Date('2026-07-01T03:59:00Z'), p), true)
  // 1 July must not.
  assert.equal(inPeriod(new Date('2026-07-01T05:00:00Z'), p), false)
  assert.equal(formatBusinessDate(inclusiveEndDate(p)), 'Jun 30, 2026')
})

test('comparable prior periods map to the true calendar predecessor', () => {
  const now = new Date('2026-05-10T16:00:00Z')
  assert.equal(previousComparablePeriod(resolvePeriod('this_month', now), now).label, 'April 2026')
  assert.equal(previousComparablePeriod(resolvePeriod('this_quarter', now), now).label, 'Q1 2026')
  assert.equal(previousComparablePeriod(resolvePeriod('year_to_date', now), now).label, '2025')
})

test('a custom range compares against an equal-length window immediately before it', () => {
  const now = new Date('2026-06-15T12:00:00Z')
  const p = resolvePeriod('custom', now, { start: '2026-06-01', end: '2026-06-10' })
  const prev = previousComparablePeriod(p, now)
  assert.equal(prev.end.getTime(), p.start.getTime())
  assert.equal(prev.end.getTime() - prev.start.getTime(), p.end.getTime() - p.start.getTime())
})

// ── Safe comparison ─────────────────────────────────────────────────────────

test('percentage change is NULL against a zero prior period, with a label', () => {
  const d = compareCents(50000, 0)
  assert.equal(d.changeBp, null)
  assert.equal(d.note, 'No comparable prior-period value')
  assert.equal(d.changeCents, 50000)
})

test('percentage change is computed normally when there is a prior value', () => {
  const d = compareCents(150000, 100000)
  assert.equal(d.changeBp, 5000) // +50%
  assert.equal(d.note, null)
})

test('a decline against a prior LOSS uses the magnitude, not a sign flip', () => {
  const d = compareCents(-5000, -10000)
  assert.equal(d.changeCents, 5000)
  assert.equal(d.changeBp, 5000) // improved by 50% of the prior magnitude
})

// ── Basis + scope ───────────────────────────────────────────────────────────

const FIG = {
  netBilledRevenueCents: 200000, netCollectedRevenueCents: 180000, outstandingBalanceCents: 20000,
  directJobCostCents: 100000, crewLaborCents: 80000, ownerEconomicLaborCents: 0,
  allocatedOverheadCents: 3500, cashGrossProfitCents: 80000, economicProfitCents: 80000,
  companyNetProfitCents: 76500, economicNetProfitCents: 76500, taxReserveCents: 15300,
  businessReserveCents: 0, retainedEarningsCents: 0, distributableProfitCents: 61200,
}

const finalized: MoveFinancialRow = { bookingId: 'f1', isFinalized: true, snapshot: FIG }
const provisional: MoveFinancialRow = { bookingId: 'p1', isFinalized: false, provisional: FIG }

test('a FINALIZED move always reads its snapshot, never a recomputation', () => {
  const row: MoveFinancialRow = { bookingId: 'x', isFinalized: true, snapshot: FIG, provisional: { ...FIG, companyNetProfitCents: 999999 } }
  assert.equal(selectMoveFigures(row, 'COMBINED')?.companyNetProfitCents, 76500)
  assert.equal(selectMoveFigures(row, 'FINALIZED_ONLY')?.companyNetProfitCents, 76500)
})

test('FINALIZED_ONLY excludes provisional moves entirely', () => {
  const t = aggregateMoves([finalized, provisional], 'FINALIZED_ONLY')
  assert.equal(t.moveCount, 1)
  assert.equal(t.finalizedCount, 1)
  assert.equal(t.provisionalCount, 0)
  assert.equal(t.companyNetProfitCents, 76500)
})

test('PROVISIONAL_ONLY excludes finalized moves entirely', () => {
  const t = aggregateMoves([finalized, provisional], 'PROVISIONAL_ONLY')
  assert.equal(t.moveCount, 1)
  assert.equal(t.provisionalCount, 1)
})

test('COMBINED reports BOTH counts so the mix is never hidden', () => {
  const t = aggregateMoves([finalized, provisional], 'COMBINED')
  assert.equal(t.moveCount, 2)
  assert.equal(t.finalizedCount, 1)
  assert.equal(t.provisionalCount, 1)
  assert.equal(isMixedSource(t), true)
  assert.equal(t.companyNetProfitCents, 153000)
})

test('a mixed COMBINED total carries an explicit warning', () => {
  const label = describeBasis('CASH', 'COMBINED', { finalized: 1, provisional: 1 })
  assert.equal(label.source, 'MIXED')
  assert.match(label.warning ?? '', /not been financially finalized/)
})

test('COMBINED with nothing provisional is reported as FINALIZED, no warning', () => {
  const label = describeBasis('CASH', 'COMBINED', { finalized: 3, provisional: 0 })
  assert.equal(label.source, 'FINALIZED')
  assert.equal(label.warning, null)
})

test('a provisional-only report always warns', () => {
  assert.match(describeBasis('ACCRUAL', 'PROVISIONAL_ONLY').warning ?? '', /provisional/)
})

test('the basis label names both the basis and the scope', () => {
  const l = describeBasis('CASH', 'FINALIZED_ONLY')
  assert.match(l.label, /Cash basis/)
  assert.match(l.label, /finalized moves only/)
})

test('CASH revenue is collected; ACCRUAL revenue is billed', () => {
  const t = aggregateMoves([finalized], 'FINALIZED_ONLY')
  assert.equal(revenueForBasis(t, 'CASH'), 180000)
  assert.equal(revenueForBasis(t, 'ACCRUAL'), 200000)
  // The uncollected $200 is visible as a receivable, not as cash.
  assert.equal(t.outstandingBalanceCents, 20000)
})

test('margin uses COLLECTED revenue and is null when nothing was collected', () => {
  const t = aggregateMoves([finalized], 'FINALIZED_ONLY')
  assert.equal(t.marginBp, Math.round((76500 / 180000) * 10_000))
  const none = aggregateMoves([{ bookingId: 'z', isFinalized: true, snapshot: { ...FIG, netCollectedRevenueCents: 0, companyNetProfitCents: -500 } }], 'FINALIZED_ONLY')
  assert.equal(none.marginBp, null)
})

test('a move with no usable figures is COUNTED as unusable, never silently dropped', () => {
  const broken: MoveFinancialRow = { bookingId: 'b', isFinalized: true, snapshot: null }
  const t = aggregateMoves([finalized, broken], 'FINALIZED_ONLY')
  assert.equal(t.moveCount, 1)
  assert.equal(t.unusableCount, 1)
})

test('a period LOSS aggregates as a negative, never floored', () => {
  const loss: MoveFinancialRow = {
    bookingId: 'l', isFinalized: true,
    snapshot: { ...FIG, netCollectedRevenueCents: 50000, companyNetProfitCents: -45000, cashGrossProfitCents: -41500, distributableProfitCents: 0, taxReserveCents: 0 },
  }
  const t = aggregateMoves([loss], 'FINALIZED_ONLY')
  assert.equal(t.companyNetProfitCents, -45000)
  assert.ok((t.marginBp ?? 0) < 0)
  assert.equal(t.distributableProfitCents, 0)
})
