// ============================================================================
// customer-balance.test.ts — the ONE customer-balance model (job-money).
//
// THE DEFECT THIS PINS (production booking WMIC-1015, 2026-07-21):
//   base labor $409, travel $50, truck add-on $50, quote $459, deposit $49
//   captured. The admin displayed "Due on move day: $100" — the sum of the fee
//   columns — while the customer actually owed $460. The unpaid base-service
//   balance was omitted from every surface that showed an amount owed.
//
// Every assertion below exists so that number can never be shown again.
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { customerBalance, additionalChargeCents, jobWarnings } from '../job-money'

type P = { amount: number; status: string; isInternalTest?: boolean; refundedAmountCents?: number | null }

const booking = (over: Record<string, unknown> = {}, payments: P[] = []) =>
  ({ status: 'CONFIRMED', payments, ...over }) as never

const deposit = (amount = 4900): P => ({ amount, status: 'COMPLETED' })

// ── The reported defect ─────────────────────────────────────────────────────

test('WMIC-1015: a $459 quote with a $50 truck add-on and a $49 deposit owes $460, not $100', () => {
  const b = customerBalance(
    booking(
      { baseRate: 409, totalEstimate: 459, travelFee: 5000, truckAddonAmount: 5000, truckAddonDueOnMoveDay: true },
      [deposit()],
    ),
  )
  assert.equal(b.quotedCents, 45_900)
  assert.equal(b.additionalChargeCents, 5_000) // truck add-on only — travel is inside the quote
  assert.equal(b.finalBilledCents, 50_900)
  assert.equal(b.collectedCents, 4_900)
  assert.equal(b.outstandingCents, 46_000)
  assert.equal(b.dueOnMoveDayCents, 46_000)
  assert.notEqual(b.dueOnMoveDayCents, 10_000) // the old fee-column answer
})

test('WMIC-1014: no fee columns at all still owes the unpaid base balance', () => {
  // The old formula returned 0 here and told the owner the customer owed nothing.
  const b = customerBalance(booking({ baseRate: 699, totalEstimate: 699 }, [deposit()]))
  assert.equal(b.additionalChargeCents, 0)
  assert.equal(b.outstandingCents, 65_000)
})

test('the travel fee is billed exactly once', () => {
  const b = customerBalance(booking({ baseRate: 409, totalEstimate: 459, travelFee: 5000 }))
  assert.equal(b.finalBilledCents, 45_900) // NOT 50_900
  assert.equal(additionalChargeCents(booking({ travelFee: 5000 })), 0)
})

test('the closeout bills the same gross charges the job page shows', () => {
  // closeout-service composes `quotedCents + additionalChargeCents`. It used to
  // compose `estimate + moveDayDueCents`, which added the travel fee a second
  // time and inflated billed revenue (and the receivable) by exactly $50.
  const b = customerBalance(
    booking({ baseRate: 409, totalEstimate: 459, travelFee: 5000, truckAddonAmount: 5000, truckAddonDueOnMoveDay: true }),
  )
  assert.equal(b.quotedCents + b.additionalChargeCents, 50_900)
  assert.notEqual(b.quotedCents + b.additionalChargeCents, 55_900) // the double-counted answer
})

// ── Charge composition ──────────────────────────────────────────────────────

test('base labor only', () => {
  const b = customerBalance(booking({ baseRate: 359, totalEstimate: 359 }))
  assert.equal(b.finalBilledCents, 35_900)
  assert.equal(b.outstandingCents, 35_900)
})

test('an unselected truck add-on is never billed', () => {
  const b = customerBalance(booking({ totalEstimate: 409, truckAddonAmount: 5000, truckAddonDueOnMoveDay: false }))
  assert.equal(b.additionalChargeCents, 0)
  assert.equal(b.finalBilledCents, 40_900)
})

test('itemized move-day charges add on top of the quote', () => {
  const b = customerBalance(
    booking({ totalEstimate: 409, stairFee: 4000, longCarryFee: 3000, heavyItemFee: 6000, taxAmount: 500 }),
  )
  assert.equal(b.additionalChargeCents, 13_500)
  assert.equal(b.finalBilledCents, 54_400)
})

test('a waiting fee is a real customer charge', () => {
  const b = customerBalance(booking({ totalEstimate: 409, waitingFeeOverride: 5000 }))
  assert.equal(b.additionalChargeCents, 5_000)
  assert.equal(b.outstandingCents, 45_900)
})

test('a waived waiting fee is not charged', () => {
  const b = customerBalance(booking({ totalEstimate: 409, waitingFeeOverride: 5000, waitingFeeWaived: true }))
  assert.equal(b.additionalChargeCents, 0)
})

// ── Discounts ───────────────────────────────────────────────────────────────

test('a stored discount percent actually reduces the billed amount', () => {
  // Before this model the percent was displayed but never applied to any total.
  const b = customerBalance(booking({ totalEstimate: 500, discountPercent: 10 }))
  assert.equal(b.discountCents, 5_000)
  assert.equal(b.finalBilledCents, 45_000)
})

test('a discount applies to add-ons as well as the quote', () => {
  const b = customerBalance(
    booking({ totalEstimate: 400, truckAddonAmount: 5000, truckAddonDueOnMoveDay: true, discountPercent: 10 }),
  )
  assert.equal(b.discountCents, 4_500)
  assert.equal(b.finalBilledCents, 40_500)
})

// ── Payments, refunds, credits ──────────────────────────────────────────────

test('multiple payments reduce the balance cumulatively', () => {
  const b = customerBalance(
    booking({ totalEstimate: 459, truckAddonAmount: 5000, truckAddonDueOnMoveDay: true }, [
      deposit(),
      { amount: 40_000, status: 'COMPLETED' },
    ]),
  )
  assert.equal(b.collectedCents, 44_900)
  assert.equal(b.outstandingCents, 6_000)
})

test('a move-day cash payment settles the balance to zero', () => {
  const b = customerBalance(booking({ totalEstimate: 459 }, [deposit(), { amount: 41_000, status: 'COMPLETED' }]))
  assert.equal(b.outstandingCents, 0)
  assert.equal(b.dueOnMoveDayCents, 0)
})

test('a partial refund puts money back on the balance', () => {
  const b = customerBalance(
    booking({ totalEstimate: 459 }, [deposit(), { amount: 41_000, status: 'PARTIALLY_REFUNDED', refundedAmountCents: 10_000 }]),
  )
  assert.equal(b.collectedCents, 35_900)
  assert.equal(b.refundedCents, 10_000)
  assert.equal(b.outstandingCents, 10_000)
})

test('a full refund restores the whole balance', () => {
  const b = customerBalance(
    booking({ totalEstimate: 459 }, [{ amount: 4_900, status: 'REFUNDED', refundedAmountCents: 4_900 }]),
  )
  assert.equal(b.collectedCents, 0)
  assert.equal(b.outstandingCents, 45_900)
})

test('an authorized-but-uncaptured hold is not collected money', () => {
  const b = customerBalance(booking({ totalEstimate: 459 }, [{ amount: 4_900, status: 'PENDING' }]))
  assert.equal(b.collectedCents, 0)
  assert.equal(b.outstandingCents, 45_900)
})

test("the owner's internal test payments never pay down a real balance", () => {
  const b = customerBalance(booking({ totalEstimate: 459 }, [{ amount: 45_900, status: 'COMPLETED', isInternalTest: true }]))
  assert.equal(b.collectedCents, 0)
  assert.equal(b.outstandingCents, 45_900)
})

test('overcollection reports a zero balance, never a negative one', () => {
  const b = customerBalance(booking({ totalEstimate: 100 }, [{ amount: 50_000, status: 'COMPLETED' }]))
  assert.equal(b.outstandingCents, 0)
})

// ── Missing data is disclosed, never silently zeroed ─────────────────────────

test('a booking with no stored quote rebuilds it from base labor + travel and says so', () => {
  const b = customerBalance(booking({ baseRate: 509, travelFee: 5000, totalEstimate: null }, [deposit()]))
  assert.equal(b.quoteMissing, true)
  assert.equal(b.quotedCents, 55_900)
  assert.equal(b.outstandingCents, 51_000)
})

test('a real quote is not flagged as missing', () => {
  assert.equal(customerBalance(booking({ totalEstimate: 459 })).quoteMissing, false)
})

// ── The customer-facing portal reads the same model ─────────────────────────

test('the portal "Remaining balance" includes the truck add-on', () => {
  // my-booking/[token] used to compute `estimateTotal − $49`, which omitted the
  // $50 truck add-on because estimate.ts keeps it OUTSIDE estimatedTotal. The
  // customer was quoted $410 on a $460 debt.
  const b = customerBalance(
    booking({ totalEstimate: 459, truckAddonAmount: 5000, truckAddonDueOnMoveDay: true }, [deposit()]),
  )
  assert.equal(b.outstandingCents, 46_000)
  assert.notEqual(b.outstandingCents, 41_000) // estimateTotal − deposit
})

test('the portal balance reflects payments made after the deposit', () => {
  const b = customerBalance(booking({ totalEstimate: 459 }, [deposit(), { amount: 20_000, status: 'COMPLETED' }]))
  assert.equal(b.outstandingCents, 21_000) // not a flat estimate − $49
})

test('the portal shows no balance at all when no quote is stored', () => {
  // quoteMissing suppresses the number rather than quoting a rebuilt one.
  assert.equal(customerBalance(booking({ baseRate: null, totalEstimate: null })).quoteMissing, true)
})

// ── The warning that reads the balance ──────────────────────────────────────

test('a completed move with an unpaid base balance raises the balance-due warning', () => {
  // The fee-column formula produced no warning at all on this shape.
  const w = jobWarnings(booking({ status: 'COMPLETED', totalEstimate: 699, originAddress: 'a', destAddress: 'b' }, [deposit()]))
  assert.ok(w.includes('Balance due after job'))
})

test('a fully paid completed move raises no balance warning', () => {
  const w = jobWarnings(
    booking({ status: 'COMPLETED', totalEstimate: 699, originAddress: 'a', destAddress: 'b' }, [
      deposit(),
      { amount: 65_000, status: 'COMPLETED' },
    ]),
  )
  assert.ok(!w.includes('Balance due after job'))
})
