// Offline tests for the canonical pricing helpers + consistency checker.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bookingPricing, pricingConsistencyIssues, formatUSD, formatCentsUSD, centsToDollars } from '../pricing'

test('pricing: baseRate is DOLLARS — $409 never becomes $4.09', () => {
  const p = bookingPricing({ baseRate: 409, totalEstimate: 409 })
  assert.equal(p.baseDollars, 409)
  assert.equal(formatUSD(p.baseDollars!), '$409.00')
  // The historical bug: dividing dollars by 100.
  assert.notEqual(formatUSD(p.baseDollars! / 100), '$409.00')
})

test('pricing: CENTS fields format correctly (travel fee $50, deposit $49)', () => {
  const p = bookingPricing({ travelFee: 5000, depositAmount: 4900, truckAddonAmount: 5000, truckAddonDueOnMoveDay: true })
  assert.equal(p.travelFeeDollars, 50)
  assert.equal(p.depositDollars, 49)
  assert.equal(p.truckAddonDollars, 50)
  assert.equal(formatCentsUSD(5000), '$50.00')
  assert.equal(centsToDollars(4900), 49)
})

test('pricing: an authorized-but-not-captured $49 hold is NOT counted as collected', () => {
  const p = bookingPricing({ depositAmount: 4900, depositPaid: false, payments: [] })
  assert.equal(p.depositAuthorized, true)
  assert.equal(p.depositCaptured, false)
  assert.equal(p.collectedDollars, 0) // held, not collected
})

test('pricing: after capture, collected reflects the COMPLETED payment only', () => {
  const p = bookingPricing({
    depositAmount: 4900,
    depositPaid: true,
    payments: [{ amount: 4900, status: 'COMPLETED' }, { amount: 4900, status: 'FAILED' }],
  })
  assert.equal(p.depositCaptured, true)
  assert.equal(p.collectedDollars, 49) // only the COMPLETED one
})

test('pricing: move total = base + travel; balance after job = total − deposit; not double-counted', () => {
  const p = bookingPricing({ baseRate: 699, travelFee: 5000, totalEstimate: 749, depositAmount: 4900 })
  assert.equal(p.moveTotalDollars, 749)
  assert.equal(p.balanceAfterJobDollars, 700)
  // Travel appears once in the total and once as a move-day line — not added twice.
  assert.equal(p.dueOnMoveDayDollars, 50)
  assert.deepEqual(pricingConsistencyIssues({ baseRate: 699, travelFee: 5000, totalEstimate: 749 }), [])
})

test('pricing: consistency checker flags a divergent total and dollars-as-cents', () => {
  assert.ok(pricingConsistencyIssues({ baseRate: 699, travelFee: 5000, totalEstimate: 999 }).some((i) => /totalEstimate/.test(i)))
  assert.ok(pricingConsistencyIssues({ baseRate: 40900, totalEstimate: 40900 }).some((i) => /cents/.test(i)))
})

test('pricing: due-on-move-day is 0 when no travel fee and no truck add-on (nothing invented)', () => {
  const p = bookingPricing({ baseRate: 359, totalEstimate: 359, travelFee: 0, truckAddonDueOnMoveDay: false })
  assert.equal(p.dueOnMoveDayDollars, 0)
  assert.equal(p.travelFeeDollars, 0)
  assert.equal(p.truckAddonDollars, 0)
})
