// ============================================================================
// stage4-closeout-foundation.test.ts — D3 (internal-test rehearsal) and D6
// (financial setup). Both are SECURITY-SHAPED: the point is what they REFUSE.
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeCloseoutBlockers, hardBlockers, overridableBlockers } from '../closeout-blockers'
import { canOverrideBlocker } from '../closeout-guards'
import { evaluateFinancialSetup, SETUP_HEADLINE } from '../financial-setup'

const base = {
  bookingStatus: 'COMPLETED',
  hasCapturedPayment: false,
  hasUnknownRefundAmount: false,
  refundExceedsCaptured: false,
  outstandingBalanceCents: 0,
  balanceWriteOffCents: 0,
  disputedOpenCents: 0,
  disputeAcknowledged: false,
  laborState: 'PAID' as const,
  truckSourceConfirmed: true,
  truckSourceIsCostly: false,
  truckCostRecordedCents: 0,
  expensesMissingReceipt: [],
  receiptRequiredAboveCents: 2500,
  pendingExpenseCount: 0,
  ownerReimbursementOwedCents: 0,
  allocatedToOwnersCents: 0,
  distributableProfitCents: 0,
  reservesExceedProfit: false,
  hasNegativeValue: false,
}
const find = (bs: ReturnType<typeof computeCloseoutBlockers>, code: string) => bs.find((b) => b.code === code)

// ── D3: the internal-test rehearsal pathway ─────────────────────────────────

test('D3: a REAL move with no payment keeps NO_PAYMENT_DATA as HARD', () => {
  const bs = computeCloseoutBlockers({ ...base, isInternalTest: false })
  assert.equal(find(bs, 'NO_PAYMENT_DATA')?.severity, 'HARD')
  assert.ok(hardBlockers(bs).some((b) => b.code === 'NO_PAYMENT_DATA'))
})

test('D3: omitting the flag entirely defaults to the strict behaviour', () => {
  // A caller that forgets to pass isInternalTest must get the SAFE answer.
  const bs = computeCloseoutBlockers({ ...base })
  assert.equal(find(bs, 'NO_PAYMENT_DATA')?.severity, 'HARD')
})

test('D3: an INTERNAL TEST move drops NO_PAYMENT_DATA to OVERRIDABLE', () => {
  const bs = computeCloseoutBlockers({ ...base, isInternalTest: true })
  assert.equal(find(bs, 'NO_PAYMENT_DATA')?.severity, 'OVERRIDABLE')
  assert.ok(overridableBlockers(bs).some((b) => b.code === 'NO_PAYMENT_DATA'))
})

test('D3: the internal-test message says so, so nobody mistakes it for real revenue', () => {
  const bs = computeCloseoutBlockers({ ...base, isInternalTest: true })
  assert.match(find(bs, 'NO_PAYMENT_DATA')!.message, /INTERNAL TEST/)
  assert.match(find(bs, 'NO_PAYMENT_DATA')!.message, /never reach company reporting/)
})

test('D3: the flag unlocks NOTHING except NO_PAYMENT_DATA', () => {
  const strict = computeCloseoutBlockers({ ...base, laborState: 'MISSING_RATE', isInternalTest: false })
  const test_ = computeCloseoutBlockers({ ...base, laborState: 'MISSING_RATE', isInternalTest: true })
  // Labor blockers keep their severity on a test move.
  assert.equal(find(strict, 'LABOR_MISSING_RATE')?.severity, 'HARD')
  assert.equal(find(test_, 'LABOR_MISSING_RATE')?.severity, 'HARD')
  // And a data-integrity blocker is never softened.
  const bad = computeCloseoutBlockers({ ...base, refundExceedsCaptured: true, isInternalTest: true })
  assert.equal(find(bad, 'REFUND_EXCEEDS_PAYMENT')?.severity, 'HARD')
})

test('D3: overriding requires OWNER — a manager is refused', () => {
  const bs = computeCloseoutBlockers({ ...base, isInternalTest: true })
  const d = canOverrideBlocker({ role: 'MANAGER', code: 'NO_PAYMENT_DATA', reason: 'rehearsal', blockers: bs })
  assert.equal(d.allow, false)
  assert.equal(d.status, 403)
})

test('D3: overriding requires a written reason', () => {
  const bs = computeCloseoutBlockers({ ...base, isInternalTest: true })
  assert.equal(canOverrideBlocker({ role: 'OWNER', code: 'NO_PAYMENT_DATA', reason: '', blockers: bs }).allow, false)
  assert.equal(canOverrideBlocker({ role: 'OWNER', code: 'NO_PAYMENT_DATA', reason: '   ', blockers: bs }).allow, false)
})

test('D3: an OWNER with a written reason may rehearse an internal-test move', () => {
  const bs = computeCloseoutBlockers({ ...base, isInternalTest: true })
  const d = canOverrideBlocker({ role: 'OWNER', code: 'NO_PAYMENT_DATA', reason: 'Stage 4 rehearsal', blockers: bs })
  assert.equal(d.allow, true)
  assert.equal(d.overrideUsed, true)
})

test('D3: an OWNER may NOT override the same blocker on a real booking', () => {
  // The severity gate is what stops it — the role and reason are both fine.
  const bs = computeCloseoutBlockers({ ...base, isInternalTest: false })
  const d = canOverrideBlocker({ role: 'OWNER', code: 'NO_PAYMENT_DATA', reason: 'please', blockers: bs })
  assert.equal(d.allow, false)
  assert.equal(d.status, 422)
})

test('D3: crew can never override anything', () => {
  const bs = computeCloseoutBlockers({ ...base, isInternalTest: true })
  assert.equal(canOverrideBlocker({ role: 'CREW', code: 'NO_PAYMENT_DATA', reason: 'x', blockers: bs }).allow, false)
})

// ── D6: financial setup is REPORTED, never guessed ──────────────────────────

const owner = { role: 'OWNER', workerType: 'OWNER', name: 'Diego', active: true, payRate: null }

test('D6: no BusinessConfig and no rates reports setup required', () => {
  const s = evaluateFinancialSetup({ users: [owner], hasBusinessConfig: false, ownerEconomicRateCents: null })
  assert.equal(s.ready, false)
  assert.equal(s.headline, SETUP_HEADLINE)
  assert.ok(s.outstanding.some((i) => i.key === 'business_config'))
  assert.ok(s.outstanding.some((i) => i.key === 'owner_economic_rate'))
})

test('D6: production reality — config exists but no crew and no owner rate', () => {
  const s = evaluateFinancialSetup({ users: [owner, { ...owner, name: 'Sebastian' }], hasBusinessConfig: true, ownerEconomicRateCents: 3000 })
  assert.equal(s.ready, false)
  assert.ok(s.outstanding.some((i) => i.key === 'crew_exists'))
})

test('D6: an active crew member with no rate is outstanding', () => {
  const s = evaluateFinancialSetup({
    users: [owner, { role: 'CREW', name: 'Worker', active: true, payRate: null }],
    hasBusinessConfig: true,
    ownerEconomicRateCents: 3000,
  })
  assert.equal(s.ready, false)
  assert.ok(s.outstanding.some((i) => i.key === 'crew_rates'))
})

test('D6: a fully configured business is ready', () => {
  const s = evaluateFinancialSetup({
    users: [owner, { role: 'CREW', name: 'Worker', active: true, payRate: 2200 }],
    hasBusinessConfig: true,
    ownerEconomicRateCents: 3000,
  })
  assert.equal(s.ready, true)
  assert.equal(s.headline, null)
  assert.equal(s.outstanding.length, 0)
})

test('D6: an inactive crew member with no rate does not block setup', () => {
  const s = evaluateFinancialSetup({
    users: [owner, { role: 'CREW', name: 'Old', active: false, payRate: null }, { role: 'CREW', name: 'New', active: true, payRate: 2000 }],
    hasBusinessConfig: true,
    ownerEconomicRateCents: 3000,
  })
  assert.equal(s.ready, true)
})

test('D6: an owner cash rate is OPTIONAL — owners may take no wage', () => {
  const s = evaluateFinancialSetup({
    users: [owner, { role: 'CREW', name: 'Worker', active: true, payRate: 2200 }],
    hasBusinessConfig: true,
    ownerEconomicRateCents: 3000,
  })
  assert.equal(s.ready, true) // owner.payRate is null and that is fine
})

test('D6: the module never supplies a rate of its own', () => {
  // It reports; it does not default. Nothing in the output is a number that
  // could be mistaken for a configured rate.
  const s = evaluateFinancialSetup({ users: [owner], hasBusinessConfig: false, ownerEconomicRateCents: null })
  const blob = JSON.stringify(s)
  assert.ok(!/"payRate"/.test(blob))
  assert.ok(!/rateCents":\s*\d/.test(blob))
})

test('D6: a missing rate is never reported as zero', () => {
  // MISSING_RATE remains a HARD closeout blocker — labor of unknown cost can
  // never be treated as free.
  const bs = computeCloseoutBlockers({ ...base, laborState: 'MISSING_RATE' })
  assert.equal(find(bs, 'LABOR_MISSING_RATE')?.severity, 'HARD')
})
