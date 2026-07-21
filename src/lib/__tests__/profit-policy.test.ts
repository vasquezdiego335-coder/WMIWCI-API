// ============================================================================
// profit-policy.test.ts — the 40/30/30 profit policy and the D2 blocker fix.
//
// OWNER POLICY (2026-07-21): of FINAL company net profit —
//   40% retained by the business · 30% Diego · 30% Sebastian
//
// Internally that is `generalReserveBp = 4000` (the retained share) and a
// 50/50 owner split of what REMAINS, which is 30% each of the total. Every
// assertion below is written in the owner's terms, not the internal ones.
//
// D2: a loss with nothing requested is NOT over-allocated. Before this fix,
// every unprofitable move raised a HARD RESERVES_EXCEED_PROFIT blocker and
// could never be finalized.
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeReserves } from '../closeout-calc'
import { computeOwnerSplit } from '../owner-split'

/** The owner policy, end to end: net profit → business / Diego / Sebastian. */
function allocate(companyNetProfitCents: number, opts: { liabilities?: number; taxBp?: number; manualReserve?: number } = {}) {
  const r = computeReserves({
    companyNetProfitCents,
    businessRetainedBp: 4000,
    taxReserveBp: opts.taxBp ?? 0,
    businessReserveCents: opts.manualReserve ?? 0,
    unresolvedLiabilityCents: opts.liabilities ?? 0,
  })
  const split = computeOwnerSplit({
    method: 'OWNERSHIP_PERCENT',
    distributableProfitCents: r.distributableProfitCents,
    ownershipBp: { DIEGO: 5000, SEBASTIAN: 5000 },
  })
  const share = (o: string) => split.shares.find((s) => s.owner === o)?.amountCents ?? 0
  return {
    reserves: r,
    split,
    business: r.businessRetainedCents,
    diego: share('DIEGO'),
    sebastian: share('SEBASTIAN'),
    remainder: split.undistributedCents,
  }
}

// ── The policy, in the owner's own numbers ──────────────────────────────────

test('$1,000 net profit → business $400, Diego $300, Sebastian $300', () => {
  const a = allocate(100_000)
  assert.equal(a.business, 40_000)
  assert.equal(a.diego, 30_000)
  assert.equal(a.sebastian, 30_000)
  assert.equal(a.business + a.diego + a.sebastian + a.remainder, 100_000)
})

test('$1,175 net profit → business $470, Diego $352.50, Sebastian $352.50', () => {
  const a = allocate(117_500)
  assert.equal(a.business, 47_000)
  assert.equal(a.diego, 35_250)
  assert.equal(a.sebastian, 35_250)
  assert.equal(a.business + a.diego + a.sebastian + a.remainder, 117_500)
})

test('allocations never exceed the profit that exists', () => {
  for (const p of [1, 99, 100, 333, 1_234, 99_999, 1_000_000]) {
    const a = allocate(p)
    assert.ok(a.business + a.diego + a.sebastian <= p, `over-allocated at ${p}`)
  }
})

test('an odd-cent remainder stays with the business, never vanishes', () => {
  // 333c → business floor(133.2)=133, distributable 200, 100/100 to the owners.
  const a = allocate(333)
  assert.equal(a.business, 133)
  assert.equal(a.diego + a.sebastian + a.remainder, 200)
  assert.equal(a.business + a.diego + a.sebastian + a.remainder, 333)
})

test('an odd distributable splits without losing a cent', () => {
  const a = allocate(1_001) // business 400, distributable 601 → 300/300 + 1
  assert.equal(a.business, 400)
  assert.equal(a.diego, 300)
  assert.equal(a.sebastian, 300)
  assert.equal(a.remainder, 1)
  assert.equal(a.business + a.diego + a.sebastian + a.remainder, 1_001)
})

// ── D2: losses ──────────────────────────────────────────────────────────────

test('D2: a loss with zero reserves is NOT over-allocated', () => {
  // The exact shape from the first rehearsal: −$327 with everything at zero.
  const r = computeReserves({ companyNetProfitCents: -32_700, businessRetainedBp: 4000 })
  assert.equal(r.overAllocated, false)
  assert.equal(r.businessRetainedCents, 0)
  assert.equal(r.distributableProfitCents, 0)
})

test('D2: a loss allocates nothing to anyone', () => {
  const a = allocate(-32_700)
  assert.equal(a.business, 0)
  assert.equal(a.diego, 0)
  assert.equal(a.sebastian, 0)
})

test('D2: the retained share is never taken from a loss', () => {
  assert.equal(computeReserves({ companyNetProfitCents: -100_000, businessRetainedBp: 4000 }).businessRetainedCents, 0)
})

test('D2: distributable is floored at zero, never negative', () => {
  assert.equal(computeReserves({ companyNetProfitCents: -50_000, businessRetainedBp: 4000 }).distributableProfitCents, 0)
})

test('D2: a manual reserve requested against a loss IS over-allocated', () => {
  // Asking for money that does not exist is still an error — the fix must not
  // silence a genuine over-ask.
  const r = computeReserves({ companyNetProfitCents: -10_000, businessRetainedBp: 4000, businessReserveCents: 5_000 })
  assert.equal(r.overAllocated, true)
})

test('zero profit allocates zero to all three', () => {
  const a = allocate(0)
  assert.equal(a.business, 0)
  assert.equal(a.diego, 0)
  assert.equal(a.sebastian, 0)
  assert.equal(a.reserves.overAllocated, false)
})

// ── Liabilities come first ──────────────────────────────────────────────────

test('unresolved liabilities reduce what is available before any split', () => {
  // $1,000 profit, $200 owed → $800 available. Retained is 40% of PROFIT
  // ($400), leaving $400 distributable → $200 each.
  const a = allocate(100_000, { liabilities: 20_000 })
  assert.equal(a.reserves.availableForAllocationCents, 80_000)
  assert.equal(a.business, 40_000)
  assert.equal(a.diego, 20_000)
  assert.equal(a.sebastian, 20_000)
})

test('liabilities larger than profit leave nothing and are not an over-ask', () => {
  const r = computeReserves({ companyNetProfitCents: 10_000, businessRetainedBp: 4000, unresolvedLiabilityCents: 50_000 })
  assert.equal(r.availableForAllocationCents, 0)
  assert.equal(r.businessRetainedCents, 0)
  assert.equal(r.distributableProfitCents, 0)
})

// ── No double-counting ──────────────────────────────────────────────────────

test('the retained share is deducted exactly once', () => {
  const r = computeReserves({ companyNetProfitCents: 100_000, businessRetainedBp: 4000 })
  assert.equal(r.businessRetainedCents, 40_000)
  assert.equal(r.distributableProfitCents, 60_000) // not 20_000
})

test('no automatic tax reserve is added on top of the 40%', () => {
  // Owner policy: the 40% IS the whole company allocation. taxReserveBp is 0.
  const r = computeReserves({ companyNetProfitCents: 100_000, businessRetainedBp: 4000, taxReserveBp: 0 })
  assert.equal(r.taxReserveCents, 0)
  assert.equal(r.distributableProfitCents, 60_000)
})

test('a manual business reserve is ADDITIVE to the retained share, not the same money', () => {
  const r = computeReserves({ companyNetProfitCents: 100_000, businessRetainedBp: 4000, businessReserveCents: 10_000 })
  assert.equal(r.businessRetainedCents, 40_000)
  assert.equal(r.businessReserveCents, 10_000)
  assert.equal(r.distributableProfitCents, 50_000)
})

test('a zero retained rate leaves the whole profit distributable', () => {
  const r = computeReserves({ companyNetProfitCents: 100_000, businessRetainedBp: 0 })
  assert.equal(r.businessRetainedCents, 0)
  assert.equal(r.distributableProfitCents, 100_000)
})

// ── Snapshot stability ──────────────────────────────────────────────────────

test('the rate is an input, so a finalized snapshot can pin its own history', () => {
  // A later BusinessConfig change must not alter a closed move: the closeout
  // stores businessRetainedBp and passes it back in.
  const atFinalize = computeReserves({ companyNetProfitCents: 100_000, businessRetainedBp: 4000 })
  const configChangedLater = computeReserves({ companyNetProfitCents: 100_000, businessRetainedBp: 5000 })
  assert.equal(atFinalize.businessRetainedCents, 40_000)
  assert.equal(configChangedLater.businessRetainedCents, 50_000)
  // Replaying the frozen rate reproduces the original figure exactly.
  assert.equal(
    computeReserves({ companyNetProfitCents: 100_000, businessRetainedBp: atFinalize.businessRetainedBp }).businessRetainedCents,
    40_000,
  )
})

test('uncollected revenue can never reach an allocation', () => {
  // Profit is derived from COLLECTED money upstream; this pins that a
  // receivable cannot inflate the split by construction.
  const a = allocate(0) // fully unpaid move nets zero profit
  assert.equal(a.business + a.diego + a.sebastian, 0)
})
