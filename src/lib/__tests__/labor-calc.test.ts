// Phase 1 — labor pay, rate snapshots, owner labor, and the gig-board seam.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeLaborPay,
  rollupLabor,
  buildRateSnapshot,
  linkCrewJobToAssignment,
  paidCentsOf,
  derivePaymentStatus,
  legacyPayStatusFor,
  payForMinutes,
  overtimeRateFor,
  hasRateSnapshot,
  contributesLabor,
  type LaborAssignment,
} from '../labor-calc'

const HOURLY_25: LaborAssignment = {
  payModel: 'HOURLY',
  workerType: 'EMPLOYEE',
  approvalStatus: 'APPROVED',
  hourlyRateCentsSnapshot: 2500,
  overtimeRateCentsSnapshot: 3750,
  workedMinutes: 480,
}

test('payForMinutes prices a span at a per-HOUR rate', () => {
  assert.equal(payForMinutes(480, 2500), 20000) // 8h × $25 = $200
  assert.equal(payForMinutes(30, 2500), 1250)
  assert.equal(payForMinutes(0, 2500), 0)
  assert.equal(payForMinutes(480, 0), 0)
})

test('the worked example: 8h at $25/h = $200', () => {
  const p = computeLaborPay(HOURLY_25)
  assert.equal(p.regularPayCents, 20000)
  assert.equal(p.overtimePayCents, 0)
  assert.equal(p.calculatedPayCents, 20000)
  assert.equal(p.cashCostCents, 20000)
})

test('overtime is paid at the overtime snapshot', () => {
  // 10h worked: 8h × $25 + 2h × $37.50 = $200 + $75 = $275
  const p = computeLaborPay({ ...HOURLY_25, workedMinutes: 600 })
  assert.equal(p.regularPayCents, 20000)
  assert.equal(p.overtimePayCents, 7500)
  assert.equal(p.calculatedPayCents, 27500)
})

test('overtimeRateFor falls back to the multiplier on the regular snapshot', () => {
  assert.equal(overtimeRateFor({ hourlyRateCentsSnapshot: 2000 }, 150), 3000)
  assert.equal(overtimeRateFor({ hourlyRateCentsSnapshot: 2000, overtimeRateCentsSnapshot: 5000 }, 150), 5000)
})

test('flat pay ignores hours entirely', () => {
  const p = computeLaborPay({ payModel: 'FLAT', flatPayCentsSnapshot: 40000, workedMinutes: 999 })
  assert.equal(p.calculatedPayCents, 40000)
})

test('day rate ignores hours entirely', () => {
  const p = computeLaborPay({ payModel: 'DAY_RATE', dayRateCentsSnapshot: 30000, workedMinutes: 600 })
  assert.equal(p.calculatedPayCents, 30000)
})

test('driver, crew-leader and other bonuses all add', () => {
  const p = computeLaborPay({
    ...HOURLY_25,
    driverBonusCentsSnapshot: 2500,
    crewLeaderBonusCentsSnapshot: 1500,
    otherBonusCents: 1000,
  })
  assert.equal(p.bonusCents, 5000)
  assert.equal(p.calculatedPayCents, 25000)
})

test('a labor-specific reimbursement adds to the payable amount', () => {
  const p = computeLaborPay({ ...HOURLY_25, reimbursementCents: 3200 })
  assert.equal(p.reimbursementCents, 3200)
  assert.equal(p.calculatedPayCents, 23200)
})

test('separate-rate travel is priced at the travel rate, and only once', () => {
  const p = computeLaborPay({
    ...HOURLY_25,
    travelMinutes: 60,
    travelPayPolicy: 'SEPARATE_RATE',
    travelRateCentsSnapshot: 1500,
  })
  assert.equal(p.travelPayCents, 1500)
  assert.equal(p.regularPayCents, 20000) // travel NOT also in regular
  assert.equal(p.calculatedPayCents, 21500)
})

test('an owner-approved amount overrides the calculated figure', () => {
  const p = computeLaborPay({ ...HOURLY_25, approvedPayCents: 18000 })
  assert.equal(p.calculatedPayCents, 20000)
  assert.equal(p.effectivePayCents, 18000)
  assert.equal(p.cashCostCents, 18000)
})

// ── THE SNAPSHOT RULE ───────────────────────────────────────────────────────

test('REGRESSION: a later profile-rate change must NOT alter a snapshotted move', () => {
  const assignedAt25: LaborAssignment = {
    payModel: 'HOURLY',
    hourlyRateCentsSnapshot: 2500,
    workedMinutes: 480,
    userProfilePayRate: 3000, // the worker has since been raised to $30/h
  }
  const p = computeLaborPay(assignedAt25)
  assert.equal(p.calculatedPayCents, 20000) // $200 at the LOCKED $25 — not $240
  assert.equal(p.usedLegacyFallback, false)
})

test('a pre-snapshot legacy row still prices from the profile rate, and says so', () => {
  const legacy: LaborAssignment = { legacyActualHours: 8, userProfilePayRate: 3000 }
  const p = computeLaborPay(legacy)
  assert.equal(p.usedLegacyFallback, true)
  assert.equal(p.calculatedPayCents, 24000)
})

test('hasRateSnapshot distinguishes Phase 1 rows from legacy ones', () => {
  assert.equal(hasRateSnapshot({ hourlyRateCentsSnapshot: 2500 }), true)
  assert.equal(hasRateSnapshot({ flatPayCentsSnapshot: 0 }), true)
  assert.equal(hasRateSnapshot({ payModel: 'UNPAID_OWNER' }), true)
  assert.equal(hasRateSnapshot({ legacyPayRate: 2500 }), false)
  assert.equal(hasRateSnapshot({}), false)
})

test('buildRateSnapshot: an explicit rate beats the profile default', () => {
  const s = buildRateSnapshot({ payModel: 'HOURLY', userProfilePayRateCents: 2500, hourlyRateCents: 3000, workerType: 'EMPLOYEE' })
  assert.equal(s.hourlyRateCentsSnapshot, 3000)
  assert.equal(s.rateSnapshotSource, 'manual')
})

test('buildRateSnapshot: the profile default seeds the snapshot when nothing is typed', () => {
  const s = buildRateSnapshot({ payModel: 'HOURLY', userProfilePayRateCents: 2500, workerType: 'EMPLOYEE' })
  assert.equal(s.hourlyRateCentsSnapshot, 2500)
  assert.equal(s.overtimeRateCentsSnapshot, 3750)
  assert.equal(s.rateSnapshotSource, 'user_profile')
})

test('buildRateSnapshot: an OWNER always gets an economic rate, even when paid', () => {
  const s = buildRateSnapshot({ payModel: 'HOURLY', hourlyRateCents: 4000, ownerEconomicRateCents: 3000, workerType: 'OWNER' })
  assert.equal(s.economicRateCentsSnapshot, 3000)
  const e = buildRateSnapshot({ payModel: 'HOURLY', hourlyRateCents: 4000, workerType: 'EMPLOYEE' })
  assert.equal(e.economicRateCentsSnapshot, null)
})

// ── OWNER LABOR: cash vs economic ───────────────────────────────────────────

test('unpaid owner labor costs $0 CASH but carries a real economic value', () => {
  // 10 owner hours at a $30/h replacement rate.
  const p = computeLaborPay({
    payModel: 'UNPAID_OWNER',
    workerType: 'OWNER',
    workedMinutes: 600,
    economicRateCentsSnapshot: 3000,
  })
  assert.equal(p.cashCostCents, 0)
  assert.equal(p.economicValueCents, 30000)
  assert.equal(p.unpaidOwnerValueCents, 30000)
  assert.equal(p.isUnpaidOwnerLabor, true)
})

test('PAID owner labor is cash, and carries no unpaid subsidy', () => {
  // 10h at $30/h WITH the house 8h overtime rule: 8×$30 + 2×$45 = $240 + $90.
  const p = computeLaborPay({ payModel: 'HOURLY', workerType: 'OWNER', hourlyRateCentsSnapshot: 3000, workedMinutes: 600, economicRateCentsSnapshot: 3000 })
  assert.equal(p.regularPayCents, 24000)
  assert.equal(p.overtimePayCents, 9000)
  assert.equal(p.cashCostCents, 33000)
  // Paid owner time is not a subsidy — the business really spent it.
  assert.equal(p.unpaidOwnerValueCents, 0)
  assert.equal(p.economicValueCents, p.cashCostCents)
})

test('CONFIRMED $0 labor is genuinely zero on BOTH sides', () => {
  const p = computeLaborPay({ payModel: 'ZERO_CONFIRMED', zeroLaborConfirmed: true, workedMinutes: 480 })
  assert.equal(p.cashCostCents, 0)
  assert.equal(p.economicValueCents, 0)
  assert.equal(p.unpaidOwnerValueCents, 0)
})

// ── Rollup: only APPROVED labor is a cost ───────────────────────────────────

test('only APPROVED labor counts as a cost; drafts are pending, not free', () => {
  const r = rollupLabor([
    { ...HOURLY_25, approvalStatus: 'APPROVED' },
    { ...HOURLY_25, approvalStatus: 'DRAFT' },
  ])
  assert.equal(r.approvedCashCents, 20000)
  assert.equal(r.pendingCashCents, 20000)
  assert.equal(r.approvedCount, 1)
  assert.equal(r.pendingCount, 1)
})

test('cancelled, declined, no-show and rejected labor count NOWHERE', () => {
  for (const status of ['CANCELLED', 'DECLINED', 'NO_SHOW'] as const) {
    assert.equal(contributesLabor({ assignmentStatus: status }), false)
    const r = rollupLabor([{ ...HOURLY_25, assignmentStatus: status }])
    assert.equal(r.approvedCashCents, 0, status)
  }
  assert.equal(rollupLabor([{ ...HOURLY_25, approvalStatus: 'REJECTED' }]).approvedCashCents, 0)
})

test('rollup: paid and unpaid partition the approved total', () => {
  const r = rollupLabor([{ ...HOURLY_25, paidCents: 12000 }])
  assert.equal(r.approvedCashCents, 20000)
  assert.equal(r.paidCents, 12000)
  assert.equal(r.unpaidCents, 8000)
})

test('rollup: an overpayment never produces negative debt', () => {
  const r = rollupLabor([{ ...HOURLY_25, paidCents: 25000 }])
  assert.equal(r.unpaidCents, 0)
})

test('rollup: owner + helper produce distinct cash and economic totals', () => {
  // Owner works 10h unpaid ($30/h economic); helper paid $300 flat.
  const r = rollupLabor([
    { payModel: 'UNPAID_OWNER', workerType: 'OWNER', approvalStatus: 'APPROVED', workedMinutes: 600, economicRateCentsSnapshot: 3000 },
    { payModel: 'FLAT', approvalStatus: 'APPROVED', flatPayCentsSnapshot: 30000 },
  ])
  assert.equal(r.approvedCashCents, 30000) // only the helper is cash
  assert.equal(r.economicCents, 60000) // + $300 of owner time
  assert.equal(r.unpaidOwnerValueCents, 30000)
})

// ── Payments ────────────────────────────────────────────────────────────────

test('paidCentsOf ignores voided payments', () => {
  assert.equal(paidCentsOf([{ amountCents: 25000 }, { amountCents: 10000, voided: true }]), 25000)
})

test('derivePaymentStatus covers unpaid / partial / paid', () => {
  assert.equal(derivePaymentStatus(40000, 0), 'UNPAID')
  assert.equal(derivePaymentStatus(40000, 25000), 'PARTIALLY_PAID')
  assert.equal(derivePaymentStatus(40000, 40000), 'PAID')
  assert.equal(derivePaymentStatus(40000, 45000), 'PAID')
})

test('the legacy CrewPayStatus mirror stays consistent for old readers', () => {
  assert.equal(legacyPayStatusFor('APPROVED', 'PAID', 'COMPLETED'), 'PAID')
  assert.equal(legacyPayStatusFor('APPROVED', 'UNPAID', 'COMPLETED'), 'PAY_APPROVED')
  assert.equal(legacyPayStatusFor('DRAFT', 'UNPAID', 'COMPLETED'), 'COMPLETED')
  assert.equal(legacyPayStatusFor('DRAFT', 'UNPAID', 'IN_PROGRESS'), 'WORKING')
  assert.equal(legacyPayStatusFor('DRAFT', 'UNPAID', 'ASSIGNED'), 'SCHEDULED')
})

// ── The Discord gig-board seam ──────────────────────────────────────────────

test('a gig with NO move can never become move labor', () => {
  // This is every crew_job today: the table has no booking column.
  const d = linkCrewJobToAssignment({ crewJobId: 'cj1', userId: 'u1', payoutTotalCents: 15000, acceptedAt: new Date(), jobId: null })
  assert.equal(d.link, false)
  assert.match(d.link === false ? d.reason : '', /not attached to a customer move/)
})

test('an unmapped Discord worker is refused, never guessed', () => {
  const d = linkCrewJobToAssignment({ crewJobId: 'cj1', userId: null, payoutTotalCents: 15000, acceptedAt: new Date(), jobId: 'job1' })
  assert.equal(d.link, false)
})

test('a gig with no locked payout produces no labor record', () => {
  const d = linkCrewJobToAssignment({ crewJobId: 'cj1', userId: 'u1', payoutTotalCents: 0, acceptedAt: new Date(), jobId: 'job1' })
  assert.equal(d.link, false)
})

test('a linkable gig becomes a FLAT-PAY snapshot — counted once, in JobCrew', () => {
  const d = linkCrewJobToAssignment({ crewJobId: 'cj1', userId: 'u1', payoutTotalCents: 15000, acceptedAt: new Date(), jobId: 'job1' })
  assert.equal(d.link, true)
  if (d.link) {
    assert.equal(d.flatPayCents, 15000)
    assert.equal(d.snapshot.payModel, 'FLAT')
    assert.equal(d.snapshot.flatPayCentsSnapshot, 15000)
    assert.equal(d.snapshot.rateSnapshotSource, 'crew_job')
    // Pricing that snapshot yields the gig payout EXACTLY once.
    const p = computeLaborPay({ payModel: 'FLAT', flatPayCentsSnapshot: d.snapshot.flatPayCentsSnapshot })
    assert.equal(p.calculatedPayCents, 15000)
  }
})

test('a replayed acceptance yields the same decision (idempotent by crewJobId)', () => {
  const acc = { crewJobId: 'cj1', userId: 'u1', payoutTotalCents: 15000, acceptedAt: new Date(), jobId: 'job1' }
  assert.deepEqual(linkCrewJobToAssignment(acc), linkCrewJobToAssignment(acc))
})
