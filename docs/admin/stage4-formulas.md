# Stage 4 — financial formulas

Extracted from `src/lib/closeout-calc.ts`, `owner-split.ts` and
`profit-allocation.ts`. Integer CENTS throughout; rates in basis points
(4000 = 40.00%). `CALCULATION_VERSION = "phase2.1"` is stamped on every snapshot
so a stored figure records which formulas produced it.

## Revenue

```
netBilledRevenue   = max(0, grossCustomerCharges − discounts − credits)
netCollectedRevenue= capturedPayments − refunds − lostChargebacks   (money-rules)
outstandingBalance = max(0, netBilled − netCollected − balanceWriteOff)
```

Internal-test payments are excluded before any of this runs.

## Direct job cost

```
directJobCost = approvedCrewLabor
              + eligibleExpenses          (approved, job-linked)
              + processingFees            (estimated Stripe fees on captured card money)
              + standaloneTruckCost       (normally 0 — truck costs are expenses)
```

Rejected and unreviewed expenses contribute **nothing**.

## Profit

```
cashGrossProfit  = netCollectedRevenue − directJobCost
economicProfit   = cashGrossProfit     − unpaidOwnerLaborValue
companyNetProfit = cashGrossProfit     − allocatedOverhead
economicNetProfit= companyNetProfit    − unpaidOwnerLaborValue
marginBp         = round(companyNetProfit / netCollectedRevenue × 10000)   or null
```

`companyNetProfit` is the base for the allocation. All four may be negative.

## Labor

```
paidMinutes        = regularMinutes + overtimeMinutes + paidTravelMinutes
workedMinutes      = elapsed(clockIn → clockOut) − breakMinutes
overtimeMinutes    = max(0, workedMinutes − overtimeThresholdMinutes)      (default 480)
crewCashPay        = regular × hourlyRate + overtime × (hourlyRate × multiplier/100)
ownerEconomicValue = paidMinutes / 60 × economicRateCentsSnapshot
```

Rates come from the assignment's SNAPSHOT, never from the live profile. A worker
with hours and no applicable rate produces `laborState = MISSING_RATE`, which is
a HARD blocker — never a $0 cost.

## Overhead

| Method | Amount |
| --- | --- |
| `NONE` | 0 |
| `PER_MOVE` | `overheadPerMoveCents` |
| `PCT_REVENUE` | `netCollected × pctRevenueBp / 10000` |
| `PER_LABOR_HOUR` | `approvedLaborMinutes / 60 × perLaborHourCents` |
| `MONTHLY_POOL` | `monthlyPoolCents / max(1, eligibleMovesInPeriod)` |
| `MANUAL` | `overheadAmountCents` (owner-entered, reason required) |

## Reserves and distributable profit

```
positiveProfit      = max(0, companyNetProfit)
availableForAlloc   = max(0, companyNetProfit − unresolvedLiabilities)
businessRetained    = min(availableForAlloc, floor(positiveProfit × businessRetainedBp / 10000))
taxReserve          = taxReserveFixed ?? floor(positiveProfit × taxReserveBp / 10000)
requested           = businessRetained + taxReserve + businessReserves + retainedEarnings
distributableProfit = max(0, availableForAlloc − requested)
overAllocated       = requested > availableForAlloc
```

`unresolvedLiabilities` = unpaid approved crew labor + owner reimbursements owed.
Liabilities come out **before** anything is allocated.

`overAllocated` means *somebody asked for more than exists* — not `raw < 0`.
That distinction is what lets a losing move be finalized: zero requested against
a loss is not an over-allocation.

## The 40/30/30 allocation

```
businessLine   = businessRetained + roundingRemainder
ownerShare_i   = floor(distributableProfit × ownershipBp_i / 10000)
roundingRemainder = max(0, distributableProfit − Σ ownerShare_i)
shareOfNetBp_i = round((10000 − businessRetainedBp) × ownershipBp_i / 10000)
```

With `businessRetainedBp = 4000` and a 50/50 internal split, `shareOfNetBp` is
3000 for each owner — the 30% the owner sees.

**Rounding rules**
* the retained share FLOORS, so the business never over-takes
* owner shares FLOOR, so owners can never exceed distributable profit
* the remainder goes to the business line
* the three lines always sum to exactly `companyNetProfit` when it is positive

**Negative profit** — `businessRetained = 0`, `distributable = 0`, every owner
share 0, `hasDistribution = false`. The loss stays visible and the move remains
finalizable.

**Zero profit** — identical to a loss, without the negative headline.

---

## Worked example 1 — profitable

Two owners, no crew. Rates $30.00/h each (the current production values).

| Input | Value |
| --- | --- |
| Quote (billed) | $1,800.00 |
| Collected (captured, no refunds) | $1,800.00 |
| Diego | 6h00 worked, 30 min break → 5h30 paid |
| Sebastian | 6h00 worked, 30 min break → 5h30 paid |
| Approved expenses (truck rental, fuel) | $260.00 |
| Rejected expense (personal lunch) | $42.00 — **excluded** |
| Processing fees (est.) | $52.20 |
| Overhead | NONE configured → $0.00 |

```
crew cash labor      = $0.00      (owners take no wage)
eligible expenses    = $260.00
processing fees      = $52.20
directJobCost        = $312.20

cashGrossProfit      = 1800.00 − 312.20            = $1,487.80
ownerEconomicLabor   = (5.5 + 5.5) h × $30.00      = $330.00
economicProfit       = 1487.80 − 330.00            = $1,157.80
allocatedOverhead    = $0.00
companyNetProfit     = $1,487.80
economicNetProfit    = $1,157.80
```

Allocation on **company net profit** of $1,487.80:

```
Business retained — 40%   $595.12
Diego allocation — 30%    $446.34
Sebastian allocation — 30% $446.34
                          ─────────
                          $1,487.80
```

Check: retained = floor(148780 × 0.40) = 59512¢. Distributable = 89268¢.
Each owner = floor(89268 × 0.5) = 44634¢. Remainder = 89268 − 89268 = 0¢.

## Worked example 2 — owner labor changes the verdict

Same job, priced low and run long.

| Input | Value |
| --- | --- |
| Collected | $700.00 |
| Diego | 7h00 paid |
| Sebastian | 7h00 paid |
| Approved expenses | $180.00 |
| Processing fees | $20.30 |
| Overhead | PER_MOVE $75.00 |

```
directJobCost      = 0 + 180.00 + 20.30            = $200.30
cashGrossProfit    = 700.00 − 200.30               = $499.70   ← "we made $500"
ownerEconomicLabor = 14 h × $30.00                 = $420.00
economicProfit     = 499.70 − 420.00               = $79.70
allocatedOverhead  = $75.00
companyNetProfit   = 499.70 − 75.00                = $424.70
economicNetProfit  = 424.70 − 420.00               = $4.70    ← the real answer
```

Allocation on $424.70:

```
Business retained — 40%   $169.88
Diego allocation — 30%    $127.41
Sebastian allocation — 30% $127.41
```

The cash books say the move made $499.70. Valued honestly, fourteen owner-hours
produced **$4.70** of economic net profit. Both numbers are reported; the second
is the one that should change how this job is priced next time.

Note the allocation is computed on `companyNetProfit` ($424.70), not on economic
net profit. Owners are paid from real money; the economic figure is a
measurement, and deducting it before the split would pay the owners twice.

## Worked example 3 — the odd cent

Company net profit **$10.01** (1001¢):

```
retained      = floor(1001 × 0.40) = 400¢
distributable = 1001 − 400         = 601¢
each owner    = floor(601 × 0.50)  = 300¢   (600¢ total)
remainder     = 601 − 600          = 1¢     → business
business line = 400 + 1            = 401¢
total         = 401 + 300 + 300    = 1001¢  ✓
```
