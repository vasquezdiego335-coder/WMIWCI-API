// ════════════════════════════════════════════════════════════════════════
//  labor-crew-rates.test.ts — the $75/worker/hour crew ladder (owner rule,
//  audited 2026-08-17).
//
//      2 workers  $150/hour   (the published two-mover product)
//      3 workers  $225/hour
//      4 workers  $300/hour
//      each additional worker  +$75/hour
//
//  Plus the snapshot rule: an ACCEPTED booking's stored laborRateCents always
//  outranks the ladder — a price-book change must never silently re-price a
//  quote a customer already accepted.
//
//  And the WMIC-1019 regression: the owner's exact oversized-inventory case
//  must trip "INVENTORY EXCEEDS SELECTED MOVE SIZE — MANUAL REVIEW" without
//  rewriting the accepted selection or price.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LABOR_ONLY,
  LABOR_MIN_WORKERS,
  LABOR_MAX_WORKERS,
  LABOR_PER_WORKER_RATE_CENTS,
  SCOPE_OVERAGE,
  laborOnlyRateCentsForWorkers,
  laborOnlyCrewSize,
  laborOnlyQuoteCents,
  laborOnlyBillingCents,
} from '../pricing-config'
import { laborOnlyEstimateCents, checkIntake, serviceCatalog } from '../product-catalog'
import { assessInventory, toInventory, INVENTORY_WARNING } from '../inventory'

// ── The ladder itself ─────────────────────────────────────────────────────

test('crew ladder: $75/worker/hour — 2→$150, 3→$225, 4→$300, +$75 each', () => {
  assert.equal(LABOR_PER_WORKER_RATE_CENTS, 7500)
  assert.equal(laborOnlyRateCentsForWorkers(2), 15000)
  assert.equal(laborOnlyRateCentsForWorkers(3), 22500)
  assert.equal(laborOnlyRateCentsForWorkers(4), 30000)
  assert.equal(laborOnlyRateCentsForWorkers(5), 37500)
  assert.equal(laborOnlyRateCentsForWorkers(6), 45000)
  // Every step is exactly one worker's rate.
  for (let w = LABOR_MIN_WORKERS; w < LABOR_MAX_WORKERS; w++) {
    assert.equal(
      laborOnlyRateCentsForWorkers(w + 1) - laborOnlyRateCentsForWorkers(w),
      LABOR_PER_WORKER_RATE_CENTS,
      `step from ${w} to ${w + 1} workers`,
    )
  }
})

test('the published two-worker product is the ladder at 2 — one source, no drift', () => {
  assert.equal(LABOR_ONLY.hourlyRateCents, laborOnlyRateCentsForWorkers(2))
  assert.equal(LABOR_ONLY.hourlyRateCents, 15000)
  assert.equal(LABOR_ONLY.includedWorkers, LABOR_MIN_WORKERS)
})

test('money functions clamp out-of-range crews to the published range', () => {
  // Below the floor prices as the floor — a caller bug can never bill a
  // one-worker rate we do not sell.
  assert.equal(laborOnlyRateCentsForWorkers(1), 15000)
  assert.equal(laborOnlyRateCentsForWorkers(0), 15000)
  assert.equal(laborOnlyRateCentsForWorkers(null), 15000)
  assert.equal(laborOnlyRateCentsForWorkers(undefined), 15000)
  // Above the cap prices as the cap — no invented mega-crew rate.
  assert.equal(laborOnlyRateCentsForWorkers(50), laborOnlyRateCentsForWorkers(LABOR_MAX_WORKERS))
  assert.equal(laborOnlyCrewSize(50), LABOR_MAX_WORKERS)
  assert.equal(laborOnlyCrewSize(1), LABOR_MIN_WORKERS)
})

// ── Intake quotes ─────────────────────────────────────────────────────────

test('quote: 3 workers × 2 hours = $450; 4 workers × 2 hours = $600', () => {
  const three = laborOnlyQuoteCents(120, 3)
  assert.ok(three.ok)
  assert.equal(three.ok && three.hourlyRateCents, 22500)
  assert.equal(three.ok && three.subtotalCents, 45000)
  assert.equal(three.ok && three.workers, 3)

  const four = laborOnlyQuoteCents(120, 4)
  assert.ok(four.ok)
  assert.equal(four.ok && four.subtotalCents, 60000)
})

test('quote: omitted workers = the two-worker product, unchanged behaviour', () => {
  const q = laborOnlyQuoteCents(180)
  assert.ok(q.ok)
  assert.equal(q.ok && q.workers, 2)
  assert.equal(q.ok && q.hourlyRateCents, 15000)
  assert.equal(q.ok && q.subtotalCents, 45000) // 3h × $150
})

test('quote: the two-hour minimum refuses at intake regardless of crew size', () => {
  const short = laborOnlyQuoteCents(60, 4)
  assert.equal(short.ok, false)
  assert.equal(!short.ok && short.code, 'labor_below_minimum')
})

test('estimate wrapper: 2-hour minimum with 4 workers bills $600, minimumApplied', () => {
  const est = laborOnlyEstimateCents(60, 4)
  assert.equal(est.minimumApplied, true)
  assert.equal(est.requestedMinutes, 60) // the customer's own answer survives
  assert.equal(est.billableMinutes, 120)
  assert.equal(est.hourlyRateCents, 30000)
  assert.equal(est.subtotalCents, 60000)
})

// ── Post-job billing + the snapshot rule ──────────────────────────────────

test('billing: 90 actual minutes on a 3-worker crew bills the 2-hour minimum at $225/hr', () => {
  const b = laborOnlyBillingCents(90, { workers: 3 })
  assert.equal(b.actualMinutes, 90)
  assert.equal(b.billableMinutes, 120)
  assert.equal(b.minimumApplied, true)
  assert.equal(b.hourlyRateCents, 22500)
  assert.equal(b.subtotalCents, 45000)
})

test('billing: an ACCEPTED snapshot rate outranks the ladder', () => {
  // The customer accepted $200/hour (say, an owner-negotiated 3-worker deal
  // written before a ladder change). Billing honours the snapshot, not today's
  // book.
  const b = laborOnlyBillingCents(120, { workers: 3, snapshotRateCents: 20000 })
  assert.equal(b.hourlyRateCents, 20000)
  assert.equal(b.subtotalCents, 40000)
})

test('billing: a zero/invalid snapshot falls back to the ladder', () => {
  assert.equal(laborOnlyBillingCents(120, { workers: 3, snapshotRateCents: 0 }).subtotalCents, 45000)
  assert.equal(laborOnlyBillingCents(120, { workers: 3, snapshotRateCents: null }).subtotalCents, 45000)
})

// ── Intake gate ───────────────────────────────────────────────────────────

const validLabor = { product: 'labor_only', laborMinutes: 180, laborService: 'loading_and_unloading' }

test('checkIntake: crew of 3 is accepted; omitted crew is accepted', () => {
  assert.deepEqual(checkIntake({ ...validLabor, laborWorkers: 3 }), [])
  assert.deepEqual(checkIntake({ ...validLabor }), [])
})

test('checkIntake: a 1-worker request is refused, not clamped', () => {
  const errs = checkIntake({ ...validLabor, laborWorkers: 1 })
  assert.equal(errs.length, 1)
  assert.equal(errs[0].code, 'labor_workers_invalid')
  assert.equal(errs[0].field, 'laborWorkers')
  assert.match(errs[0].message, /start at 2 workers/)
})

test('checkIntake: a 7-worker request is refused toward a manual plan', () => {
  const errs = checkIntake({ ...validLabor, laborWorkers: 7 })
  assert.equal(errs.length, 1)
  assert.equal(errs[0].code, 'labor_workers_invalid')
  assert.match(errs[0].message, /contact us/)
})

// ── The service catalogue publishes the ladder ────────────────────────────

test('catalog: hourly block carries the crew ladder and it matches the money path', () => {
  const labor = serviceCatalog().find((s) => s.key === 'labor_only')
  assert.ok(labor?.hourly)
  const h = labor!.hourly!
  assert.equal(h.perWorkerRateCents, 7500)
  assert.equal(h.minWorkers, 2)
  assert.equal(h.crewRatesCents['2'], 15000)
  assert.equal(h.crewRatesCents['3'], 22500)
  assert.equal(h.crewRatesCents['4'], 30000)
  for (const [w, cents] of Object.entries(h.crewRatesCents)) {
    assert.equal(cents, laborOnlyRateCentsForWorkers(Number(w)), `catalog rate for ${w} workers`)
  }
})

// ── SCOPE_OVERAGE stays a separate published price ────────────────────────
//
// SCOPE_OVERAGE is the FULL-SERVICE beyond-approved-scope rate (per additional
// 30 minutes, approval required first). It is deliberately NOT derived from —
// and must never replace or be replaced by — the labor-only crew ladder. The
// two answer different questions: "what does a labor-only crew cost per hour"
// vs "what does extra time cost when a flat-rate job outgrows its scope".

test('SCOPE_OVERAGE keeps its own published values — not derived from the ladder', () => {
  // The published per-30-minute overage rates, pinned exactly.
  assert.equal(SCOPE_OVERAGE.byCrewSize[2].amount, 75)
  assert.equal(SCOPE_OVERAGE.byCrewSize[3].amount, 105)
  assert.equal(SCOPE_OVERAGE.byCrewSize[4].amount, 140)
  assert.equal(SCOPE_OVERAGE.requiresApprovalBeforeWork, true)
})

test('the ladder and SCOPE_OVERAGE are independent: 3-crew overage is $210/hr, 3-crew labor is $225/hr', () => {
  // If either ever silently replaced the other, these two figures would
  // collapse into one. They must stay different, at their own published values.
  const overagePerHourCents = (SCOPE_OVERAGE.byCrewSize[3].amount ?? 0) * 2 * 100 // $105/30min → $210/hr
  const ladderPerHourCents = laborOnlyRateCentsForWorkers(3) // $225/hr
  assert.equal(overagePerHourCents, 21000)
  assert.equal(ladderPerHourCents, 22500)
  assert.notEqual(overagePerHourCents, ladderPerHourCents)
  // Same independence at 4 crew: $140/30min = $280/hr vs ladder $300/hr.
  assert.equal((SCOPE_OVERAGE.byCrewSize[4].amount ?? 0) * 2 * 100, 28000)
  assert.equal(laborOnlyRateCentsForWorkers(4), 30000)
})

// ── WMIC-1019: the owner's exact oversized-inventory case ─────────────────

test('WMIC-1019 regression: the spec inventory against 1 Bedroom trips the manual-review warning', () => {
  // 15 boxes, 2 beds/mattresses, 3 dressers, 2 sofas, 2 tables/chairs, 2 TVs,
  // 2 standing mirrors, assembly/disassembly — the owner's own example.
  const inv = toInventory({
    boxes: 15, beds: 2, dressers: 3, sofas: 2, tables: 2, tvs: 2, mirrors: 2, assembly: true,
  })
  const verdict = assessInventory(inv, '1br')
  assert.equal(verdict.exceedsSelected, true)
  assert.ok(verdict.warning, 'warning banner must render')
  assert.match(verdict.warning!, /INVENTORY EXCEEDS SELECTED MOVE SIZE — MANUAL REVIEW/)
  assert.equal(verdict.warning, INVENTORY_WARNING)
  // The verdict REPORTS; it never rewrites the accepted selection.
  assert.equal(verdict.selectedKey, '1br')
  assert.equal(verdict.suggestedKey, '2br')
})
