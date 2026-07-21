// Stage 3 — marketing profitability, attribution, estimate variance,
// pricing intelligence and break-even.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  scoreMarketingSource, rankByProfit, resolveAttribution, isUnknownSource,
  canCorrectAttribution, formatRoas,
} from '../marketing-profitability'
import { computeVariance, isPricingComparable, DEFAULT_THRESHOLDS } from '../estimate-variance'
import {
  recommendPrice, computeBreakEven, confidenceFor, median, withoutOutliers,
  similarityScore, CONFIDENCE_THRESHOLDS, type ComparableMove,
} from '../pricing-intelligence'

// ── Marketing profitability ─────────────────────────────────────────────────

const DOOR_HANGER = {
  sourceKey: 'DOOR_HANGER_SPRING',
  spend: { totalSpendCents: 45000 }, // $450: print + distribution
  funnel: { scans: 120, leads: 20, quotes: 12, bookings: 5, completedMoves: 4, finalizedMoves: 4 },
  money: {
    netCollectedRevenueCents: 600000, // $6,000
    finalizedNetProfitCents: 180000, // $1,800
    provisionalNetProfitCents: 0,
    directCostCents: 420000,
  },
}

test('SCENARIO 3: a door-hanger campaign scores cost-per-X and both ROAS figures', () => {
  const r = scoreMarketingSource(DOOR_HANGER)
  assert.equal(r.costPerLeadCents, 2250) // $450 / 20 = $22.50
  assert.equal(r.costPerQuoteCents, 3750) // $37.50
  assert.equal(r.costPerBookingCents, 9000) // $90.00
  assert.equal(r.costPerCompletedMoveCents, 11250) // $112.50
  assert.equal(r.revenueRoasBp, Math.round((600000 / 45000) * 10_000)) // 13.33x
  assert.equal(r.profitRoasBp, Math.round((180000 / 45000) * 10_000)) // 4.00x
  assert.equal(r.netOfSpendCents, 135000) // $1,350 after paying for the campaign
  assert.equal(r.profitable, true)
})

test('conversion rates are reported at every funnel step', () => {
  const r = scoreMarketingSource(DOOR_HANGER)
  assert.equal(r.leadToQuoteBp, 6000) // 12/20 = 60%
  assert.equal(r.quoteToBookingBp, Math.round((5 / 12) * 10_000))
  assert.equal(r.bookingToCompletedBp, 8000) // 4/5
  assert.equal(r.leadToBookingBp, 2500) // 5/20
})

test('THE RULE: high revenue with higher costs is NOT profitable', () => {
  const r = scoreMarketingSource({
    ...DOOR_HANGER,
    money: { netCollectedRevenueCents: 1000000, finalizedNetProfitCents: -50000, provisionalNetProfitCents: 0, directCostCents: 1050000 },
  })
  assert.ok((r.revenueRoasBp ?? 0) > 20_000) // looks like a 22x winner on revenue
  assert.ok((r.profitRoasBp ?? 0) < 0) // and is actually losing money
  assert.equal(r.profitable, false)
})

test('provisional profit NEVER counts toward ROAS', () => {
  const r = scoreMarketingSource({
    ...DOOR_HANGER,
    funnel: { ...DOOR_HANGER.funnel, finalizedMoves: 0 },
    money: { netCollectedRevenueCents: 600000, finalizedNetProfitCents: 0, provisionalNetProfitCents: 180000, directCostCents: 0 },
  })
  assert.equal(r.profitRoasBp, 0)
  assert.equal(r.profitable, null) // nothing proven yet
  assert.match(r.caveat ?? '', /none are financially finalized/)
})

test('an organic source with no spend reports NULL ROAS, never infinity', () => {
  const r = scoreMarketingSource({
    sourceKey: 'WEBSITE',
    spend: { totalSpendCents: 0 },
    funnel: { leads: 10, quotes: 6, bookings: 3, completedMoves: 3, finalizedMoves: 3 },
    money: { netCollectedRevenueCents: 300000, finalizedNetProfitCents: 90000, provisionalNetProfitCents: 0, directCostCents: 210000 },
  })
  assert.equal(r.profitRoasBp, null)
  assert.equal(r.revenueRoasBp, null)
  assert.equal(r.costPerLeadCents, null)
  assert.match(r.caveat ?? '', /No marketing spend/)
  assert.equal(r.profitable, true) // it still made money
})

test('formatRoas renders a multiplier, or an em dash when unknown', () => {
  assert.equal(formatRoas(40_000), '4.00x')
  assert.equal(formatRoas(null), '—')
})

test('ranking puts PROVEN profit first, never unproven lead volume', () => {
  const proven = scoreMarketingSource({ ...DOOR_HANGER, sourceKey: 'PROVEN' })
  const volume = scoreMarketingSource({
    sourceKey: 'LOTS_OF_LEADS',
    spend: { totalSpendCents: 45000 },
    funnel: { leads: 500, quotes: 200, bookings: 40, completedMoves: 40, finalizedMoves: 0 },
    money: { netCollectedRevenueCents: 5_000_000, finalizedNetProfitCents: 0, provisionalNetProfitCents: 900000, directCostCents: 0 },
  })
  assert.equal(rankByProfit([volume, proven])[0].sourceKey, 'PROVEN')
})

// ── Attribution ─────────────────────────────────────────────────────────────

const REC = {
  firstTouchSource: 'DOOR_HANGER', firstTouchCampaign: 'SPRING_2026',
  lastTouchSource: 'GOOGLE', lastTouchCampaign: 'BRAND',
  bookingSource: 'WEBSITE',
}

test('first / last / booking attribution each resolve to their own source', () => {
  assert.equal(resolveAttribution(REC, 'FIRST_TOUCH').source, 'DOOR_HANGER')
  assert.equal(resolveAttribution(REC, 'LAST_TOUCH').source, 'GOOGLE')
  assert.equal(resolveAttribution(REC, 'BOOKING').source, 'WEBSITE')
})

test('an owner-assigned source wins BOOKING attribution', () => {
  const r = resolveAttribution({ ...REC, ownerAssignedSource: 'REFERRAL' }, 'BOOKING')
  assert.equal(r.source, 'REFERRAL')
  assert.equal(r.inferred, false)
  // …and does NOT disturb first touch.
  assert.equal(resolveAttribution({ ...REC, ownerAssignedSource: 'REFERRAL' }, 'FIRST_TOUCH').source, 'DOOR_HANGER')
})

test('a missing source resolves to UNKNOWN — never a guessed campaign', () => {
  const r = resolveAttribution({}, 'BOOKING')
  assert.equal(r.source, 'UNKNOWN')
  assert.equal(isUnknownSource(r.source), true)
})

test('falling back to an older touch is FLAGGED as inferred', () => {
  const r = resolveAttribution({ firstTouchSource: 'DOOR_HANGER' }, 'LAST_TOUCH')
  assert.equal(r.source, 'DOOR_HANGER')
  assert.equal(r.inferred, true)
})

test('FIRST-TOUCH CAN NEVER BE OVERWRITTEN', () => {
  const d = canCorrectAttribution('firstTouchSource', 'the customer told me it was Google')
  assert.equal(d.allow, false)
  assert.match(d.allow === false ? d.error : '', /cannot be overwritten/)
})

test('other attribution corrections require a reason', () => {
  assert.equal(canCorrectAttribution('ownerAssignedSource').allow, false)
  assert.equal(canCorrectAttribution('ownerAssignedSource', 'Customer confirmed the door hanger').allow, true)
})

// ── Estimate variance ───────────────────────────────────────────────────────

test('SCENARIO 4: 6 hours estimated, 10 actual → labor + duration warnings', () => {
  const v = computeVariance({
    estimatedPriceCents: 90000, actualBilledCents: 90000,
    estimatedMinutes: 360, actualMinutes: 600,
    estimatedCrewMinutes: 720, actualCrewMinutes: 1200,
    estimatedLaborCents: 36000, actualLaborCents: 60000,
    estimatedTruckCents: 0, actualTruckCents: 0,
    estimatedExpenseCents: 5000, actualExpenseCents: 5000,
    actualMarginBp: 1200,
  })
  const dur = v.lines.find((l) => l.metric === 'Duration')!
  assert.equal(dur.varianceBp, Math.round((240 / 360) * 10_000)) // +66.7%
  assert.equal(dur.severity, 'WARNING')
  const labor = v.lines.find((l) => l.metric === 'Labor cost')!
  assert.equal(labor.varianceBp, Math.round((24000 / 36000) * 10_000))
  assert.ok(v.flags.some((f) => f.code === 'RAN_LONG'))
  assert.ok(v.flags.some((f) => f.code === 'CREW_HOURS_OVER'))
  assert.ok(v.flags.some((f) => f.code === 'MARGIN_BELOW_TARGET'))
  assert.equal(v.severity, 'WARNING')
})

test('a move that lost money is flagged as such, not merely low margin', () => {
  const v = computeVariance({ actualMarginBp: -1500 })
  assert.ok(v.flags.some((f) => f.code === 'MOVE_LOST_MONEY' && f.severity === 'WARNING'))
})

test('SCOPE CHANGE is surfaced so the estimate is not blamed unfairly', () => {
  const v = computeVariance({
    estimatedMinutes: 360, actualMinutes: 600,
    estimatedStops: 1, actualStops: 3, addedHeavyItems: true,
  })
  assert.equal(v.scopeChanged, true)
  assert.ok(v.scopeChangeReasons.some((r) => /more stop/.test(r)))
  assert.ok(v.flags.some((f) => f.code === 'SCOPE_CHANGED'))
})

test('extra stops worked but not billed is a WARNING', () => {
  const v = computeVariance({
    estimatedStops: 1, actualStops: 3,
    estimatedPriceCents: 90000, actualBilledCents: 90000,
  })
  assert.ok(v.flags.some((f) => f.code === 'EXTRA_STOPS_UNBILLED' && f.severity === 'WARNING'))
})

test('a missing estimate reads as "No estimate recorded", not a 100% miss', () => {
  const v = computeVariance({ actualMinutes: 600, actualLaborCents: 60000 })
  const dur = v.lines.find((l) => l.metric === 'Duration')!
  assert.equal(dur.varianceBp, null)
  assert.equal(dur.note, 'No estimate recorded')
  assert.equal(v.insufficientEstimate, true)
  assert.ok(v.flags.some((f) => f.code === 'ESTIMATE_FIELDS_MISSING'))
})

test('quoting far ABOVE the eventual price is worth knowing too', () => {
  const v = computeVariance({ estimatedPriceCents: 200000, actualBilledCents: 100000 })
  assert.ok(v.flags.some((f) => f.code === 'QUOTED_HIGH'))
})

test('a clean move produces no flags', () => {
  const v = computeVariance({
    estimatedPriceCents: 90000, actualBilledCents: 92000,
    estimatedMinutes: 360, actualMinutes: 370,
    estimatedCrewMinutes: 720, actualCrewMinutes: 740,
    estimatedLaborCents: 36000, actualLaborCents: 37000,
    estimatedTruckCents: 12000, actualTruckCents: 12000,
    estimatedExpenseCents: 5000, actualExpenseCents: 5200,
    actualMarginBp: 3000,
  })
  assert.equal(v.severity, 'OK')
  assert.deepEqual(v.flags, [])
})

test('thresholds are configurable', () => {
  const input = { estimatedMinutes: 100, actualMinutes: 110 } // +10%
  const at = (v: ReturnType<typeof computeVariance>) => v.lines.find((l) => l.metric === 'Duration')!
  // 10% is inside the default 15% notice band…
  assert.equal(at(computeVariance(input)).severity, 'OK')
  assert.equal(computeVariance(input).flags.some((f) => f.code === 'RAN_LONG'), false)
  // …and outside a tightened 5% band.
  const tight = computeVariance(input, { ...DEFAULT_THRESHOLDS, noticeBp: 500 })
  assert.equal(at(tight).severity, 'NOTICE')
  assert.ok(tight.flags.some((f) => f.code === 'RAN_LONG'))
})

test('only clean, finalized, non-scope-changed moves teach pricing', () => {
  const clean = computeVariance({ estimatedMinutes: 360, actualMinutes: 370, estimatedPriceCents: 9, actualBilledCents: 9, estimatedCrewMinutes: 1, actualCrewMinutes: 1, estimatedLaborCents: 1, actualLaborCents: 1, estimatedTruckCents: 1, actualTruckCents: 1, estimatedExpenseCents: 1, actualExpenseCents: 1 })
  assert.equal(isPricingComparable(clean, true), true)
  assert.equal(isPricingComparable(clean, false), false) // not finalized
  const scoped = computeVariance({ estimatedStops: 1, actualStops: 2 })
  assert.equal(isPricingComparable(scoped, true), false)
})

// ── Pricing intelligence ────────────────────────────────────────────────────

const cmp = (i: number, price: number, cost: number): ComparableMove => ({
  bookingId: `b${i}`, serviceType: 'APARTMENT', crewSize: 2, actualMinutes: 360,
  stops: 1, originCity: 'Newark', truckSource: 'CUSTOMER_PROVIDED',
  netCollectedRevenueCents: price, directJobCostCents: cost, crewLaborCents: Math.round(cost * 0.7),
  companyNetProfitCents: price - cost, marginBp: Math.round(((price - cost) / price) * 10_000),
})

const QUERY = { serviceType: 'APARTMENT', crewSize: 2, estimatedMinutes: 360, stops: 1, city: 'Newark', truckSource: 'CUSTOMER_PROVIDED' }

test('confidence tiers follow the documented policy', () => {
  assert.equal(confidenceFor(0), 'INSUFFICIENT')
  assert.equal(confidenceFor(CONFIDENCE_THRESHOLDS.low - 1), 'INSUFFICIENT')
  assert.equal(confidenceFor(3), 'LOW')
  assert.equal(confidenceFor(5), 'LOW')
  assert.equal(confidenceFor(6), 'MODERATE')
  assert.equal(confidenceFor(15), 'MODERATE')
  assert.equal(confidenceFor(16), 'STRONG')
})

test('INSUFFICIENT history returns NO PRICE — a confident guess is worse than none', () => {
  const r = recommendPrice(QUERY, [cmp(1, 90000, 50000), cmp(2, 95000, 52000)])
  assert.equal(r.confidence, 'INSUFFICIENT')
  assert.equal(r.suggestedRange, null)
  assert.equal(r.medianPriceCents, null)
  assert.match(r.caveats[0], /at least 3/)
  assert.equal(r.quoteApplied, false)
})

test('SCENARIO 8: enough comparables produce a range, confidence and assumptions', () => {
  const moves = [cmp(1, 80000, 50000), cmp(2, 90000, 52000), cmp(3, 100000, 55000), cmp(4, 95000, 53000), cmp(5, 85000, 51000), cmp(6, 92000, 54000)]
  const r = recommendPrice(QUERY, moves)
  assert.equal(r.confidence, 'MODERATE')
  assert.equal(r.comparableCount, 6)
  assert.ok(r.suggestedRange!.lowCents <= r.medianPriceCents!)
  assert.ok(r.suggestedRange!.highCents >= r.medianPriceCents!)
  assert.ok(r.assumptions.includes('finalized moves only'))
  assert.ok(r.assumptions.some((a) => a.includes('APARTMENT')))
  assert.equal(r.breakEvenPriceCents, median(moves.map((m) => m.directJobCostCents)))
  assert.ok(r.caveats.some((c) => /no quote has been created/i.test(c)))
  assert.equal(r.quoteApplied, false)
})

test('the suggested floor is never below the typical direct cost', () => {
  // Prices scattered low, costs high: the range must be lifted to break-even.
  const moves = [cmp(1, 40000, 60000), cmp(2, 45000, 60000), cmp(3, 50000, 60000), cmp(4, 120000, 60000)]
  const r = recommendPrice(QUERY, moves)
  assert.ok(r.suggestedRange!.lowCents >= r.breakEvenPriceCents!)
  assert.ok(r.caveats.some((c) => /raised to break-even/.test(c)))
})

test('a low-confidence result says so explicitly', () => {
  const r = recommendPrice(QUERY, [cmp(1, 90000, 50000), cmp(2, 95000, 52000), cmp(3, 92000, 51000)])
  assert.equal(r.confidence, 'LOW')
  assert.ok(r.caveats.some((c) => /only 3 comparable/.test(c)))
})

test('outliers are dropped from the range and reported', () => {
  const normal = [90000, 92000, 94000, 91000, 93000, 95000]
  const withWild = [...normal, 900000]
  const { kept, dropped } = withoutOutliers(withWild)
  assert.equal(dropped.length, 1)
  assert.equal(kept.length, normal.length)
})

test('with fewer than 4 points nothing is treated as an outlier', () => {
  assert.equal(withoutOutliers([10, 20, 900]).dropped.length, 0)
})

test('median resists a single nightmare move; mean does not', () => {
  assert.equal(median([100, 200, 300, 400, 100000]), 300)
})

test('a dissimilar move is not used as a comparable', () => {
  const different: ComparableMove = { ...cmp(9, 90000, 50000), serviceType: 'OFFICE', crewSize: 5, originCity: 'Trenton', truckSource: 'RENTAL' }
  assert.ok(similarityScore(QUERY, different).score < 35)
  const r = recommendPrice(QUERY, [different, different, different, different])
  assert.equal(r.confidence, 'INSUFFICIENT')
})

test('similarity reports WHICH dimensions matched', () => {
  const s = similarityScore(QUERY, cmp(1, 90000, 50000))
  assert.ok(s.matched.includes('service type'))
  assert.ok(s.matched.includes('crew size'))
})

test('when no comparable move was profitable, the recommendation says so', () => {
  const moves = [cmp(1, 40000, 60000), cmp(2, 42000, 60000), cmp(3, 41000, 60000)]
  const r = recommendPrice(QUERY, moves)
  assert.ok(r.caveats.some((c) => /None of the comparable moves were profitable/.test(c)))
})

// ── Break-even ──────────────────────────────────────────────────────────────

test('three distinct break-even floors, and unpaid owner time is NOT free', () => {
  const b = computeBreakEven({
    crewSize: 2, estimatedMinutes: 360, hourlyRateCents: 2500,
    ownerUnpaidMinutes: 360, ownerEconomicRateCents: 3000,
    truckCents: 12000, fuelCents: 4000, tollsCents: 1500, suppliesCents: 2000,
    overheadCents: 3500, processingFeeBp: 290, targetMarginBp: 2000,
  })
  // 2 crew × 6h = 12h × $25 = $300
  assert.equal(b.cashLaborCents, 30000)
  assert.equal(b.otherDirectCents, 19500)
  assert.equal(b.directCostBreakEvenCents, 49500)
  assert.equal(b.cashBreakEvenCents, 53000) // + overhead
  assert.equal(b.ownerEconomicLaborCents, 18000) // 6h × $30
  assert.equal(b.economicBreakEvenCents, 71000)
  assert.ok(b.economicBreakEvenCents > b.cashBreakEvenCents)
  assert.ok(b.targetPriceCents > b.cashBreakEvenCents)
  assert.ok(b.expectedEconomicProfitCents < b.expectedCashProfitCents)
})

test('the target price actually achieves the target margin after fees', () => {
  const b = computeBreakEven({ crewSize: 2, estimatedMinutes: 360, hourlyRateCents: 2500, overheadCents: 0, processingFeeBp: 290, targetMarginBp: 2000 })
  assert.ok(Math.abs((b.expectedMarginBp ?? 0) - 2000) <= 50) // within 0.5pt of target
})

test('break-even shows its assumptions', () => {
  const b = computeBreakEven({ crewSize: 3, estimatedMinutes: 240, hourlyRateCents: 2500, ownerUnpaidMinutes: 120, ownerEconomicRateCents: 3000, overheadCents: 3500 })
  assert.ok(b.assumptions.some((a) => /3 crew/.test(a)))
  assert.ok(b.assumptions.some((a) => /unpaid owner time/.test(a)))
  assert.ok(b.assumptions.some((a) => /overhead/.test(a)))
})

test('a flat labor cost overrides the hourly calculation', () => {
  const b = computeBreakEven({ crewSize: 2, estimatedMinutes: 360, hourlyRateCents: 2500, flatLaborCents: 40000 })
  assert.equal(b.cashLaborCents, 40000)
})
