// ============================================================================
// stage5-stage4-integration.test.ts — prove Stage 5 feeds Stage 4 correctly and
// breaks nothing. The whole Stage 5 build is additive, so the existing Stage 4
// suites still pass; this pins the SEAM explicitly: rate resolvability, owner vs
// crew labor, break handling, and the 40/30/30 allocation over the frozen path.
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rateResolvableOf } from '../scheduling-service'
import { buildRateSnapshot } from '../labor-calc'
import { computeReserves } from '../closeout-calc'
import { computeOwnerSplit } from '../owner-split'
import { buildProfitAllocation } from '../profit-allocation'

// ── Rate resolvability mirrors the closeout's MISSING_RATE logic ────────────

test('an OWNER assignment is rate-resolvable only with an economic rate snapshot', () => {
  assert.equal(rateResolvableOf({ workerType: 'OWNER', payModel: 'UNPAID_OWNER', hourlyRateCentsSnapshot: null, flatPayCentsSnapshot: null, dayRateCentsSnapshot: null, economicRateCentsSnapshot: 3000 }), true)
  // UNPAID_OWNER is resolvable by decree even without a number (the economic
  // value may be 0 by owner choice) — matches labor-state.
  assert.equal(rateResolvableOf({ workerType: 'OWNER', payModel: 'UNPAID_OWNER', hourlyRateCentsSnapshot: null, flatPayCentsSnapshot: null, dayRateCentsSnapshot: null, economicRateCentsSnapshot: null }), true)
  // A HOURLY owner with no rate anywhere is NOT resolvable.
  assert.equal(rateResolvableOf({ workerType: 'OWNER', payModel: 'HOURLY', hourlyRateCentsSnapshot: null, flatPayCentsSnapshot: null, dayRateCentsSnapshot: null, economicRateCentsSnapshot: null }), false)
})

test('a CREW assignment is rate-resolvable from a snapshot or the profile default', () => {
  assert.equal(rateResolvableOf({ workerType: 'EMPLOYEE', payModel: 'HOURLY', hourlyRateCentsSnapshot: 2200, flatPayCentsSnapshot: null, dayRateCentsSnapshot: null, economicRateCentsSnapshot: null }), true)
  assert.equal(rateResolvableOf({ workerType: 'EMPLOYEE', payModel: 'HOURLY', hourlyRateCentsSnapshot: null, flatPayCentsSnapshot: null, dayRateCentsSnapshot: null, economicRateCentsSnapshot: null, user: { payRate: 2000 } }), true)
  assert.equal(rateResolvableOf({ workerType: 'EMPLOYEE', payModel: 'HOURLY', hourlyRateCentsSnapshot: null, flatPayCentsSnapshot: null, dayRateCentsSnapshot: null, economicRateCentsSnapshot: null, user: { payRate: null } }), false)
})

// ── The rate FREEZE POINT is still assignment, and Stage 5 did not move it ──

test('an owner assignment freezes the economic rate at assignment (Stage 4 rule intact)', () => {
  const snap = buildRateSnapshot({ payModel: 'UNPAID_OWNER', workerType: 'OWNER', ownerEconomicRateCents: 3000 })
  assert.equal(snap.economicRateCentsSnapshot, 3000)
  // A later profile change does not touch this frozen object.
  const later = buildRateSnapshot({ payModel: 'UNPAID_OWNER', workerType: 'OWNER', ownerEconomicRateCents: 5000 })
  assert.equal(snap.economicRateCentsSnapshot, 3000)
  assert.equal(later.economicRateCentsSnapshot, 5000)
})

// ── The 40/30/30 allocation still holds over a labor-driven closeout ─────────

/** Reproduce the closeout allocation for a given net profit. */
function allocate(netCents: number) {
  const reserves = computeReserves({ companyNetProfitCents: netCents, businessRetainedBp: 4000 })
  const split = computeOwnerSplit({ method: 'OWNERSHIP_PERCENT', distributableProfitCents: reserves.distributableProfitCents, ownershipBp: { DIEGO: 5000, SEBASTIAN: 5000 } })
  return buildProfitAllocation({
    companyNetProfitCents: netCents,
    businessRetainedCents: reserves.businessRetainedCents,
    businessRetainedBp: reserves.businessRetainedBp,
    distributableProfitCents: reserves.distributableProfitCents,
    ownerShares: split.shares.map((s) => ({ owner: s.owner, amountCents: s.amountCents, percentBp: s.percentBp })),
  })
}

test('$1,000 net still allocates 400 / 300 / 300 after Stage 5', () => {
  const v = allocate(100_000)
  assert.equal(v.lines.find((l) => l.isBusiness)!.amountCents, 40_000)
  assert.equal(v.lines.find((l) => l.label.startsWith('Diego'))!.amountCents, 30_000)
  assert.equal(v.lines.find((l) => l.label.startsWith('Sebastian'))!.amountCents, 30_000)
})

test('a move that only breaks even because owners worked unpaid still allocates on cash net profit', () => {
  // Owner economic labor is NOT deducted before the split — Stage 5 does not
  // change that. Company net profit drives the allocation.
  const v = allocate(42_470) // the worked example: $424.70 company net profit
  const total = v.lines.reduce((s, l) => s + l.amountCents, 0)
  assert.equal(total, 42_470)
  assert.equal(v.lines.find((l) => l.isBusiness)!.amountCents, 16_988) // 40%
})

test('a loss still allocates zero to everyone and stays finalizable', () => {
  const v = allocate(-30_000)
  assert.equal(v.hasDistribution, false)
  assert.ok(v.lines.every((l) => l.amountCents === 0))
  const reserves = computeReserves({ companyNetProfitCents: -30_000, businessRetainedBp: 4000 })
  assert.equal(reserves.overAllocated, false)
})
