// Phase 2 — blockers, overrides, finalization, owner split, distributions.
// These are the exact predicates the closeout routes call, so a pass here is a
// statement about route behavior, not a parallel re-implementation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeCloseoutBlockers,
  evaluateFinalize,
  deriveCloseoutStatus,
  hardBlockers,
  overridableBlockers,
  isOverridable,
} from '../closeout-blockers'
import {
  canFinalizeCloseout,
  canOverrideBlocker,
  canReopenCloseout,
  canEditCloseoutInputs,
  canSetReserves,
  canSetOverhead,
  canSetOwnerSplit,
  canRecordDistribution,
} from '../closeout-guards'
import { computeOwnerSplit, validateDistribution } from '../owner-split'

const CLEAN = {
  bookingStatus: 'COMPLETED',
  hasCapturedPayment: true,
  hasUnknownRefundAmount: false,
  refundExceedsCaptured: false,
  outstandingBalanceCents: 0,
  balanceWriteOffCents: 0,
  disputedOpenCents: 0,
  disputeAcknowledged: false,
  laborState: 'APPROVED_UNPAID',
  truckSourceConfirmed: true,
  truckSourceIsCostly: false,
  truckCostRecordedCents: 0,
  expensesMissingReceipt: [],
  receiptRequiredAboveCents: 2500,
  pendingExpenseCount: 0,
  ownerReimbursementOwedCents: 0,
  allocatedToOwnersCents: 0,
  distributableProfitCents: 100000,
  reservesExceedProfit: false,
  hasNegativeValue: false,
}

// ── Blockers ────────────────────────────────────────────────────────────────

test('a clean move has no blockers and can be finalized', () => {
  const b = computeCloseoutBlockers(CLEAN)
  assert.deepEqual(b, [])
  assert.equal(evaluateFinalize(b).canFinalize, true)
})

test('HARD: no captured payment', () => {
  const b = computeCloseoutBlockers({ ...CLEAN, hasCapturedPayment: false })
  assert.ok(b.some((x) => x.code === 'NO_PAYMENT_DATA' && x.severity === 'HARD'))
})

test('HARD: a refund larger than its payment can never be overridden', () => {
  const b = computeCloseoutBlockers({ ...CLEAN, refundExceedsCaptured: true })
  assert.ok(b.some((x) => x.code === 'REFUND_EXCEEDS_PAYMENT' && x.severity === 'HARD'))
  assert.equal(isOverridable('REFUND_EXCEEDS_PAYMENT', b), false)
  const d = evaluateFinalize(b, [{ code: 'REFUND_EXCEEDS_PAYMENT', reason: 'trust me' }])
  assert.equal(d.canFinalize, false) // the override did nothing
})

test('HARD: an unknown partial refund amount', () => {
  assert.ok(computeCloseoutBlockers({ ...CLEAN, hasUnknownRefundAmount: true }).some((x) => x.code === 'UNKNOWN_REFUND_AMOUNT' && x.severity === 'HARD'))
})

test('HARD: unapproved labor is not yet a cost, so the move is not closeable', () => {
  const b = computeCloseoutBlockers({ ...CLEAN, laborState: 'HOURS_UNAPPROVED' })
  assert.ok(b.some((x) => x.code === 'LABOR_NOT_APPROVED' && x.severity === 'HARD'))
})

test('HARD: a missing clock-out or a missing rate', () => {
  assert.ok(computeCloseoutBlockers({ ...CLEAN, laborState: 'MISSING_CLOCK_OUT' }).some((x) => x.code === 'LABOR_MISSING_CLOCK_OUT' && x.severity === 'HARD'))
  assert.ok(computeCloseoutBlockers({ ...CLEAN, laborState: 'MISSING_RATE' }).some((x) => x.code === 'LABOR_MISSING_RATE' && x.severity === 'HARD'))
})

test('HARD: allocations or reserves exceeding profit', () => {
  assert.ok(computeCloseoutBlockers({ ...CLEAN, allocatedToOwnersCents: 200000 }).some((x) => x.code === 'ALLOCATION_EXCEEDS_PROFIT' && x.severity === 'HARD'))
  assert.ok(computeCloseoutBlockers({ ...CLEAN, reservesExceedProfit: true }).some((x) => x.code === 'RESERVES_EXCEED_PROFIT' && x.severity === 'HARD'))
})

test('OVERRIDABLE: an outstanding balance is a judgement call', () => {
  const b = computeCloseoutBlockers({ ...CLEAN, outstandingBalanceCents: 50000 })
  const blocker = b.find((x) => x.code === 'OUTSTANDING_BALANCE')
  assert.ok(blocker)
  assert.equal(blocker?.severity, 'OVERRIDABLE')
  assert.equal(evaluateFinalize(b).canFinalize, false)
  assert.equal(evaluateFinalize(b, [{ code: 'OUTSTANDING_BALANCE', reason: 'Written off — customer hardship' }]).canFinalize, true)
})

test('OVERRIDABLE: truck source must be CONFIRMED — absence is not $0', () => {
  const b = computeCloseoutBlockers({ ...CLEAN, truckSourceConfirmed: false })
  assert.ok(b.some((x) => x.code === 'TRUCK_SOURCE_MISSING'))
})

test('OVERRIDABLE: a rental truck with no recorded cost', () => {
  const b = computeCloseoutBlockers({ ...CLEAN, truckSourceIsCostly: true, truckCostRecordedCents: 0 })
  assert.ok(b.some((x) => x.code === 'TRUCK_COST_MISSING'))
  // A customer-provided truck raises nothing.
  assert.equal(computeCloseoutBlockers({ ...CLEAN, truckSourceIsCostly: false }).some((x) => x.code === 'TRUCK_COST_MISSING'), false)
})

test('OVERRIDABLE: a missing receipt only blocks ABOVE the policy threshold', () => {
  const big = computeCloseoutBlockers({ ...CLEAN, expensesMissingReceipt: [{ id: '1', label: 'Fuel', amountCents: 8000 }] })
  assert.ok(big.some((x) => x.code === 'RECEIPT_MISSING'))
  const small = computeCloseoutBlockers({ ...CLEAN, expensesMissingReceipt: [{ id: '1', label: 'Toll', amountCents: 800 }] })
  assert.equal(small.some((x) => x.code === 'RECEIPT_MISSING'), false)
})

test('OVERRIDABLE: an open dispute clears once acknowledged', () => {
  assert.ok(computeCloseoutBlockers({ ...CLEAN, disputedOpenCents: 50000 }).some((x) => x.code === 'OPEN_DISPUTE'))
  assert.equal(computeCloseoutBlockers({ ...CLEAN, disputedOpenCents: 50000, disputeAcknowledged: true }).some((x) => x.code === 'OPEN_DISPUTE'), false)
})

test('OVERRIDABLE: a pending owner reimbursement', () => {
  assert.ok(computeCloseoutBlockers({ ...CLEAN, ownerReimbursementOwedCents: 15000 }).some((x) => x.code === 'OWNER_REIMBURSEMENT_PENDING'))
})

test('hard blockers sort before overridable ones', () => {
  const b = computeCloseoutBlockers({ ...CLEAN, hasCapturedPayment: false, outstandingBalanceCents: 5000 })
  assert.equal(b[0].severity, 'HARD')
  assert.equal(hardBlockers(b).length + overridableBlockers(b).length, b.length)
})

test('an override with a blank reason does not count', () => {
  const b = computeCloseoutBlockers({ ...CLEAN, outstandingBalanceCents: 50000 })
  assert.equal(evaluateFinalize(b, [{ code: 'OUTSTANDING_BALANCE', reason: '   ' }]).canFinalize, false)
})

// ── Status derivation ───────────────────────────────────────────────────────

test('closeout status reflects reality, not a stale stored value', () => {
  const clean = evaluateFinalize(computeCloseoutBlockers(CLEAN))
  const blocked = evaluateFinalize(computeCloseoutBlockers({ ...CLEAN, hasCapturedPayment: false }))
  assert.equal(deriveCloseoutStatus({ storedStatus: 'READY_TO_FINALIZE', started: false, submitted: false, finalized: false, reopened: false, decision: clean }), 'NOT_STARTED')
  assert.equal(deriveCloseoutStatus({ storedStatus: 'READY_TO_FINALIZE', started: true, submitted: false, finalized: false, reopened: false, decision: blocked }), 'MISSING_INFORMATION')
  assert.equal(deriveCloseoutStatus({ storedStatus: 'IN_PROGRESS', started: true, submitted: true, finalized: false, reopened: false, decision: clean }), 'READY_TO_FINALIZE')
  assert.equal(deriveCloseoutStatus({ storedStatus: 'IN_PROGRESS', started: true, submitted: false, finalized: true, reopened: false, decision: blocked }), 'FINALIZED')
  assert.equal(deriveCloseoutStatus({ storedStatus: 'FINALIZED', started: true, submitted: true, finalized: false, reopened: true, decision: blocked }), 'REOPENED')
})

// ── Guards ──────────────────────────────────────────────────────────────────

const deny = (d: { allow: boolean; status?: number }) => (d.allow ? null : d.status)

test('SCENARIO 8: a MANAGER cannot finalize, override, reopen, or set the split', () => {
  const b = computeCloseoutBlockers(CLEAN)
  assert.equal(deny(canFinalizeCloseout({ role: 'MANAGER', alreadyFinalized: false, blockers: b, overrides: [] })), 403)
  assert.equal(deny(canOverrideBlocker({ role: 'MANAGER', code: 'OUTSTANDING_BALANCE', reason: 'x', blockers: b })), 403)
  assert.equal(deny(canReopenCloseout({ role: 'MANAGER', isFinalized: true, reason: 'x' })), 403)
  assert.equal(deny(canSetOwnerSplit({ role: 'MANAGER', isFinalized: false, splitOk: true })), 403)
  assert.equal(deny(canSetReserves({ role: 'MANAGER', isFinalized: false, companyNetProfitCents: 100000, totalReserveCents: 1000 })), 403)
})

test('SCENARIO 8: an OWNER can finalize a clean move', () => {
  assert.equal(canFinalizeCloseout({ role: 'OWNER', alreadyFinalized: false, blockers: computeCloseoutBlockers(CLEAN), overrides: [] }).allow, true)
})

test('a worker cannot finalize anything', () => {
  assert.equal(deny(canFinalizeCloseout({ role: 'CREW', alreadyFinalized: false, blockers: [], overrides: [] })), 403)
  assert.equal(deny(canFinalizeCloseout({ role: null, alreadyFinalized: false, blockers: [], overrides: [] })), 403)
})

test('finalizing twice is refused', () => {
  assert.equal(deny(canFinalizeCloseout({ role: 'OWNER', alreadyFinalized: true, blockers: [], overrides: [] })), 409)
})

test('an override needs a reason and must name an ACTIVE overridable blocker', () => {
  const b = computeCloseoutBlockers({ ...CLEAN, outstandingBalanceCents: 5000 })
  assert.equal(deny(canOverrideBlocker({ role: 'OWNER', code: 'OUTSTANDING_BALANCE', blockers: b })), 422) // no reason
  assert.equal(deny(canOverrideBlocker({ role: 'OWNER', code: 'NOT_A_BLOCKER', reason: 'x', blockers: b })), 422)
  assert.equal(canOverrideBlocker({ role: 'OWNER', code: 'OUTSTANDING_BALANCE', reason: 'Written off', blockers: b }).allow, true)
})

test('a HARD blocker cannot be overridden even by an owner with a reason', () => {
  const b = computeCloseoutBlockers({ ...CLEAN, hasCapturedPayment: false })
  assert.equal(deny(canOverrideBlocker({ role: 'OWNER', code: 'NO_PAYMENT_DATA', reason: 'I checked the bank', blockers: b })), 422)
})

test('SCENARIO 7: reopening requires an owner AND a reason', () => {
  assert.equal(deny(canReopenCloseout({ role: 'OWNER', isFinalized: true })), 422)
  assert.equal(deny(canReopenCloseout({ role: 'OWNER', isFinalized: false, reason: 'x' })), 422)
  assert.equal(canReopenCloseout({ role: 'OWNER', isFinalized: true, reason: 'Late toll receipt arrived' }).allow, true)
})

test('a FINALIZED move is locked against casual edits', () => {
  assert.equal(deny(canEditCloseoutInputs({ role: 'OWNER', isFinalized: true })), 409)
  assert.equal(canEditCloseoutInputs({ role: 'OWNER', isFinalized: false }).allow, true)
  assert.equal(canEditCloseoutInputs({ role: 'MANAGER', isFinalized: false }).allow, true)
})

test('reserves cannot exceed company net profit', () => {
  assert.equal(deny(canSetReserves({ role: 'OWNER', isFinalized: false, companyNetProfitCents: 100000, totalReserveCents: 150000 })), 422)
  assert.equal(canSetReserves({ role: 'OWNER', isFinalized: false, companyNetProfitCents: 100000, totalReserveCents: 100000 }).allow, true)
})

test('a manual overhead allocation requires a reason', () => {
  assert.equal(deny(canSetOverhead({ role: 'OWNER', isFinalized: false, method: 'MANUAL', manualCents: 5000 })), 422)
  assert.equal(canSetOverhead({ role: 'OWNER', isFinalized: false, method: 'MANUAL', manualCents: 5000, reason: 'One-off permit' }).allow, true)
  assert.equal(canSetOverhead({ role: 'OWNER', isFinalized: false, method: 'PER_MOVE' }).allow, true)
})

// ── Owner split ─────────────────────────────────────────────────────────────

test('EQUAL split halves the distributable profit', () => {
  const s = computeOwnerSplit({ method: 'EQUAL', distributableProfitCents: 60000 })
  assert.equal(s.ok, true)
  assert.equal(s.shares[0].amountCents, 30000)
  assert.equal(s.shares[1].amountCents, 30000)
  assert.equal(s.undistributedCents, 0)
})

test('the owner’s worked example: $600 distributable splits 50/50', () => {
  const s = computeOwnerSplit({ method: 'OWNERSHIP_PERCENT', distributableProfitCents: 60000, ownershipBp: { DIEGO: 5000, SEBASTIAN: 5000 } })
  assert.equal(s.shares.find((x) => x.owner === 'DIEGO')?.amountCents, 30000)
  assert.equal(s.shares.find((x) => x.owner === 'SEBASTIAN')?.amountCents, 30000)
})

test('OWNERSHIP_PERCENT respects an uneven split', () => {
  const s = computeOwnerSplit({ method: 'OWNERSHIP_PERCENT', distributableProfitCents: 100000, ownershipBp: { DIEGO: 6000, SEBASTIAN: 4000 } })
  assert.equal(s.shares.find((x) => x.owner === 'DIEGO')?.amountCents, 60000)
  assert.equal(s.shares.find((x) => x.owner === 'SEBASTIAN')?.amountCents, 40000)
})

test('ownership percentages that do not total 100% are REJECTED', () => {
  const s = computeOwnerSplit({ method: 'OWNERSHIP_PERCENT', distributableProfitCents: 100000, ownershipBp: { DIEGO: 6000, SEBASTIAN: 3000 } })
  assert.equal(s.ok, false)
  assert.match(s.error ?? '', /not 100%/)
})

test('LABOR_FIRST pays owner labor before splitting the remainder', () => {
  // $1,000 distributable; Diego is owed $300 of labor. Remainder $700 splits.
  const s = computeOwnerSplit({
    method: 'LABOR_FIRST',
    distributableProfitCents: 100000,
    ownerLaborCents: { DIEGO: 30000, SEBASTIAN: 0 },
    ownershipBp: { DIEGO: 5000, SEBASTIAN: 5000 },
  })
  const diego = s.shares.find((x) => x.owner === 'DIEGO')!
  const seb = s.shares.find((x) => x.owner === 'SEBASTIAN')!
  assert.equal(diego.laborFirstCents, 30000)
  assert.equal(diego.profitShareCents, 35000)
  assert.equal(diego.amountCents, 65000)
  assert.equal(seb.amountCents, 35000)
  assert.equal(diego.amountCents + seb.amountCents, 100000)
})

test('LABOR_FIRST pays labor PRO RATA when labor exceeds the distributable amount', () => {
  const s = computeOwnerSplit({
    method: 'LABOR_FIRST',
    distributableProfitCents: 20000,
    ownerLaborCents: { DIEGO: 30000, SEBASTIAN: 10000 },
    ownershipBp: { DIEGO: 5000, SEBASTIAN: 5000 },
  })
  assert.equal(s.shares.find((x) => x.owner === 'DIEGO')?.amountCents, 15000)
  assert.equal(s.shares.find((x) => x.owner === 'SEBASTIAN')?.amountCents, 5000)
})

test('a CUSTOM split by amount cannot exceed the distributable profit', () => {
  const bad = computeOwnerSplit({ method: 'CUSTOM', distributableProfitCents: 60000, customCents: { DIEGO: 40000, SEBASTIAN: 40000 } })
  assert.equal(bad.ok, false)
  const good = computeOwnerSplit({ method: 'CUSTOM', distributableProfitCents: 60000, customCents: { DIEGO: 40000, SEBASTIAN: 20000 } })
  assert.equal(good.ok, true)
  assert.equal(good.totalAllocatedCents, 60000)
})

test('CUSTOM percentages must total 100%', () => {
  assert.equal(computeOwnerSplit({ method: 'CUSTOM', distributableProfitCents: 60000, customPercentBp: { DIEGO: 7000, SEBASTIAN: 2000 } }).ok, false)
  assert.equal(computeOwnerSplit({ method: 'CUSTOM', distributableProfitCents: 60000, customPercentBp: { DIEGO: 7000, SEBASTIAN: 3000 } }).ok, true)
})

test('SCENARIO 6: a loss distributes nothing, and that is not an error', () => {
  const s = computeOwnerSplit({ method: 'EQUAL', distributableProfitCents: 0 })
  assert.equal(s.ok, true)
  assert.equal(s.totalAllocatedCents, 0)
  assert.ok(s.shares.every((x) => x.amountCents === 0))
})

test('a rounding remainder is REPORTED, never quietly given to one owner', () => {
  const s = computeOwnerSplit({ method: 'EQUAL', distributableProfitCents: 10001 })
  assert.equal(s.totalAllocatedCents, 10000)
  assert.equal(s.undistributedCents, 1)
})

test('parts can never sum above the whole', () => {
  for (const amount of [1, 7, 99, 10001, 123457]) {
    const s = computeOwnerSplit({ method: 'OWNERSHIP_PERCENT', distributableProfitCents: amount, ownershipBp: { DIEGO: 3333, SEBASTIAN: 6667 } })
    assert.ok(s.totalAllocatedCents <= amount, `overflow at ${amount}`)
  }
})

// ── Distributions ───────────────────────────────────────────────────────────

test('a distribution cannot exceed what is still distributable', () => {
  assert.equal(validateDistribution({ approvedCents: 70000, distributableProfitCents: 60000, alreadyAllocatedCents: 0 }).ok, false)
  assert.equal(validateDistribution({ approvedCents: 30000, distributableProfitCents: 60000, alreadyAllocatedCents: 30000 }).ok, true)
  assert.equal(validateDistribution({ approvedCents: 30001, distributableProfitCents: 60000, alreadyAllocatedCents: 30000 }).ok, false)
})

test('planning a distribution is owner-only and bounded by distributable profit', () => {
  assert.equal(deny(canRecordDistribution({ role: 'MANAGER', action: 'PLAN', amountCents: 1000, distributableProfitCents: 60000, alreadyAllocatedCents: 0 })), 403)
  assert.equal(deny(canRecordDistribution({ role: 'OWNER', action: 'PLAN', amountCents: 70000, distributableProfitCents: 60000, alreadyAllocatedCents: 0 })), 422)
  assert.equal(canRecordDistribution({ role: 'OWNER', action: 'PLAN', amountCents: 30000, distributableProfitCents: 60000, alreadyAllocatedCents: 0 }).allow, true)
})

test('a distribution must be APPROVED before it can be paid', () => {
  assert.equal(deny(canRecordDistribution({ role: 'OWNER', action: 'PAY', amountCents: 1000, distributableProfitCents: 0, alreadyAllocatedCents: 0, status: 'PLANNED', approvedCents: 30000, alreadyPaidCents: 0 })), 422)
  assert.equal(canRecordDistribution({ role: 'OWNER', action: 'PAY', amountCents: 1000, distributableProfitCents: 0, alreadyAllocatedCents: 0, status: 'APPROVED', approvedCents: 30000, alreadyPaidCents: 0 }).allow, true)
})

test('partial distribution payments work; overpayment is refused', () => {
  const base = { role: 'OWNER' as const, action: 'PAY' as const, distributableProfitCents: 0, alreadyAllocatedCents: 0, status: 'APPROVED', approvedCents: 30000 }
  assert.equal(canRecordDistribution({ ...base, amountCents: 10000, alreadyPaidCents: 0 }).allow, true)
  assert.equal(canRecordDistribution({ ...base, amountCents: 20000, alreadyPaidCents: 10000 }).allow, true)
  assert.equal(deny(canRecordDistribution({ ...base, amountCents: 20001, alreadyPaidCents: 10000 })), 422)
})

test('voiding a distribution needs an owner and a reason, and never repeats', () => {
  const base = { action: 'VOID' as const, amountCents: 0, distributableProfitCents: 0, alreadyAllocatedCents: 0 }
  assert.equal(deny(canRecordDistribution({ ...base, role: 'MANAGER', reason: 'x' })), 403)
  assert.equal(deny(canRecordDistribution({ ...base, role: 'OWNER' })), 422)
  assert.equal(deny(canRecordDistribution({ ...base, role: 'OWNER', reason: 'x', status: 'VOIDED' })), 409)
  assert.equal(canRecordDistribution({ ...base, role: 'OWNER', reason: 'Recorded twice' }).allow, true)
})
