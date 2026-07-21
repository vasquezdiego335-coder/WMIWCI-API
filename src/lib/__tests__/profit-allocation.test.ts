// ============================================================================
// profit-allocation.test.ts — the OWNER-FACING 40/30/30 presentation.
//
// The owner requirement is explicit: no surface may show "Diego 50% /
// Sebastian 50%" without showing that those percentages apply only to the
// remaining 60%. Rendered on its own, the internal split reads as "the owners
// take everything and the business keeps nothing" — the opposite of the policy.
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildProfitAllocation, bpToPercentLabel, ALLOCATION_EXPLANATION } from '../profit-allocation'
import { computeReserves } from '../closeout-calc'
import { computeOwnerSplit } from '../owner-split'

/** The whole chain: net profit → reserves → split → owner-facing view. */
function view(netProfitCents: number) {
  const r = computeReserves({ companyNetProfitCents: netProfitCents, businessRetainedBp: 4000, taxReserveBp: 0 })
  const split = computeOwnerSplit({
    method: 'OWNERSHIP_PERCENT',
    distributableProfitCents: r.distributableProfitCents,
    ownershipBp: { DIEGO: 5000, SEBASTIAN: 5000 },
  })
  return buildProfitAllocation({
    companyNetProfitCents: netProfitCents,
    businessRetainedCents: r.businessRetainedCents,
    businessRetainedBp: r.businessRetainedBp,
    distributableProfitCents: r.distributableProfitCents,
    ownerShares: split.shares.map((s) => ({ owner: s.owner, amountCents: s.amountCents, percentBp: s.percentBp })),
  })
}
const line = (v: ReturnType<typeof view>, label: string) => v.lines.find((l) => l.label.startsWith(label))!

// ── The owner's stated examples, as the owner will read them ────────────────

test('$1,000 renders Business 40% $400 · Diego 30% $300 · Sebastian 30% $300', () => {
  const v = view(100_000)
  assert.equal(line(v, 'Business').amountCents, 40_000)
  assert.equal(line(v, 'Business').ofNetProfitBp, 4000)
  assert.equal(line(v, 'Diego').amountCents, 30_000)
  assert.equal(line(v, 'Diego').ofNetProfitBp, 3000)
  assert.equal(line(v, 'Sebastian').amountCents, 30_000)
  assert.equal(line(v, 'Sebastian').ofNetProfitBp, 3000)
})

test('$1,175 renders Business $470 · Diego $352.50 · Sebastian $352.50', () => {
  const v = view(117_500)
  assert.equal(line(v, 'Business').amountCents, 47_000)
  assert.equal(line(v, 'Diego').amountCents, 35_250)
  assert.equal(line(v, 'Sebastian').amountCents, 35_250)
})

test('the owner lines are labelled 30%, never 50%', () => {
  const v = view(100_000)
  for (const owner of ['Diego', 'Sebastian']) {
    assert.equal(bpToPercentLabel(line(v, owner).ofNetProfitBp), '30%')
    assert.notEqual(bpToPercentLabel(line(v, owner).ofNetProfitBp), '50%')
  }
})

test('the business line is always present, so its share is never hidden', () => {
  const v = view(100_000)
  assert.ok(v.lines.some((l) => l.isBusiness))
  assert.equal(v.lines.length, 3)
})

test('every rendered line sums to the net profit', () => {
  const v = view(117_500)
  assert.equal(v.lines.reduce((s, l) => s + l.amountCents, 0), 117_500)
})

test('the explanation states the 40/60 structure in words', () => {
  assert.match(ALLOCATION_EXPLANATION, /40%/)
  assert.match(ALLOCATION_EXPLANATION, /remaining 60%/)
  assert.match(ALLOCATION_EXPLANATION, /30% of total final profit/)
})

// ── Rounding ────────────────────────────────────────────────────────────────

test('the rounding remainder is folded into the business line, not dropped', () => {
  const v = view(1_001) // business 400, distributable 601 → 300/300, 1c left
  assert.equal(v.roundingRemainderCents, 1)
  assert.equal(line(v, 'Business').amountCents, 401) // 400 + the stray cent
  assert.equal(v.lines.reduce((s, l) => s + l.amountCents, 0), 1_001)
})

test('no cent is lost or invented across a range of odd amounts', () => {
  for (const p of [1, 7, 99, 333, 1_001, 12_345, 99_999]) {
    const v = view(p)
    assert.equal(v.lines.reduce((s, l) => s + l.amountCents, 0), p, `sum mismatch at ${p}`)
  }
})

// ── Losses and zero ─────────────────────────────────────────────────────────

test('a loss allocates nothing and says so', () => {
  const v = view(-32_700)
  assert.equal(v.hasDistribution, false)
  for (const l of v.lines) assert.equal(l.amountCents, 0)
})

test('zero profit allocates nothing', () => {
  const v = view(0)
  assert.equal(v.hasDistribution, false)
  assert.equal(v.lines.reduce((s, l) => s + l.amountCents, 0), 0)
})

test('a loss still reports the real net profit for display', () => {
  assert.equal(view(-32_700).companyNetProfitCents, -32_700)
})

// ── Percent labels ──────────────────────────────────────────────────────────

test('whole percents stay whole and halves keep one decimal', () => {
  assert.equal(bpToPercentLabel(4000), '40%')
  assert.equal(bpToPercentLabel(3000), '30%')
  assert.equal(bpToPercentLabel(2550), '25.5%')
})

// ── Frozen-rate behaviour ───────────────────────────────────────────────────

test('a snapshot replaying its frozen rate reproduces its original lines', () => {
  // The finalized closeout stores businessRetainedBp; a later policy change
  // must not move a historical figure.
  const atFinalize = buildProfitAllocation({
    companyNetProfitCents: 100_000,
    businessRetainedCents: 40_000,
    businessRetainedBp: 4000,
    distributableProfitCents: 60_000,
    ownerShares: [
      { owner: 'DIEGO', amountCents: 30_000, percentBp: 5000 },
      { owner: 'SEBASTIAN', amountCents: 30_000, percentBp: 5000 },
    ],
  })
  assert.equal(line(atFinalize, 'Business').amountCents, 40_000)
  assert.equal(line(atFinalize, 'Diego').ofNetProfitBp, 3000)

  // Same stored numbers under a policy that has since moved to 50%.
  const laterPolicy = view(100_000)
  assert.equal(line(laterPolicy, 'Business').amountCents, 40_000) // unchanged here
  assert.deepEqual(
    atFinalize.lines.map((l) => l.amountCents),
    [40_000, 30_000, 30_000],
  )
})

test('a different retained rate re-labels the owner shares correctly', () => {
  const v = buildProfitAllocation({
    companyNetProfitCents: 100_000,
    businessRetainedCents: 50_000,
    businessRetainedBp: 5000,
    distributableProfitCents: 50_000,
    ownerShares: [
      { owner: 'DIEGO', amountCents: 25_000, percentBp: 5000 },
      { owner: 'SEBASTIAN', amountCents: 25_000, percentBp: 5000 },
    ],
  })
  // 50% retained → each owner gets 25% of net, and the label must say so.
  assert.equal(line(v, 'Diego').ofNetProfitBp, 2500)
  assert.equal(bpToPercentLabel(line(v, 'Diego').ofNetProfitBp), '25%')
})
