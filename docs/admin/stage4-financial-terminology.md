# Stage 4 — financial terminology

Every term below is a real concept in the code, with the file that owns it. Where
two terms are easy to confuse, the difference is stated rather than implied.

## Revenue

| Term | Meaning | Owner |
| --- | --- | --- |
| **Gross revenue / gross customer charges** | The stored quote plus every approved additional charge not already inside it. An ENTITLEMENT, not cash. | `job-money.customerBalance` |
| **Net billed revenue** | Gross charges − discounts − credits, floored at 0. Still not cash. | `closeout-calc.netBilledRevenueCents` |
| **Payment** | A `Payment` row. Only CAPTURED payments are revenue; an authorized-but-uncaptured hold is not. `isInternalTest` payments are excluded entirely. | `money-rules.summarizeRevenue` |
| **Refund** | Money returned. Subtracted from collected revenue — never re-added as an expense, which would double-count it. | `money-rules` |
| **Collected revenue (net collected)** | Captured − refunds − lost chargebacks. **This, and only this, is the revenue profit is computed from.** | `money-rules.summarizeRevenue` |
| **Outstanding balance** | Billed − collected − write-off, floored at 0. A RECEIVABLE. It can never reach profit or an owner allocation. | `closeout-calc.outstandingBalanceCents` |

## Costs

| Term | Meaning | Owner |
| --- | --- | --- |
| **Approved expense** | An `Expense` that passed review and is job-linked and eligible. Counted as a cost. | `money-rules.isEligibleExpense` |
| **Rejected expense** | Reviewed and refused. **Not a cost at all** — excluded from every total, not merely hidden. | `money-rules` |
| **Labor entry** | A `JobCrew` row: one worker on one job, with time, a frozen rate and an approval state. | `JobCrew` |
| **Crew labor** | Labor by a non-owner worker. A CASH cost and, until paid, a liability. | `labor-calc.rollupLabor.approvedCashCents` |
| **Owner labor** | Labor by a worker with `workerType: OWNER`. Usually no cash moves. | `labor-calc.rollupLabor.unpaidOwnerValueCents` |
| **Cash labor rate** | What a person is actually paid per hour (`User.payRate`, snapshot `hourlyRateCentsSnapshot`). May be null for an owner. | `labor-calc` |
| **Owner economic labor rate** | What an owner's hour is WORTH if it had to be hired (`User.ownerEconomicRateCents`, snapshot `economicRateCentsSnapshot`). Never cash, never a payable. | `labor-rates`, `labor-calc` |
| **Total labor cost** | Approved crew cash labor. Owner economic labor is tracked separately and does NOT enter cash cost. | `closeout-calc.directJobCostCents` |
| **Allocated overhead** | Company overhead attributed to this move by the configured method (NONE / PER_MOVE / PCT_REVENUE / PER_LABOR_HOUR / MONTHLY_POOL / MANUAL). | `closeout-calc.computeOverhead` |

## Profit

| Term | Formula | Note |
| --- | --- | --- |
| **Cash gross profit** | net collected − direct job cost | may be negative |
| **Economic profit** | cash gross profit − unpaid owner labor value | the honest one |
| **Company net profit** | cash gross profit − allocated overhead | **the base for the 40/30/30 allocation** |
| **Economic net profit** | company net profit − unpaid owner labor value | |

All four may be negative and are reported as such. A loss is never hidden.

## Allocation

| Term | Meaning |
| --- | --- |
| **Business allocation / business retained** | `generalReserveBp` (4000 = 40%) of POSITIVE company net profit, plus the rounding remainder. |
| **Owner-distributable** | What remains after the retained share, reserves and liabilities. |
| **Owner allocation** | Each owner's share of the distributable amount — 50/50 internally, which is **30% of total net profit each**. |
| **Rounding remainder** | The integer-cent leftover after the owner split. Stays with the business by policy. |

## Closeout lifecycle

| Term | Meaning |
| --- | --- |
| **Closeout** | The `MoveCloseout` row: workflow state, human confirmations, per-move overrides. Money does not live here. |
| **Finalization** | The owner locks the move. Writes a snapshot and freezes `businessRetainedBp` onto the closeout. |
| **Snapshot** | A `FinancialSnapshot` row: every figure, the allocation as presented, and the provenance of the policy that produced it. |
| **Frozen value** | A number stored so a later settings change cannot restate it — rate snapshots on `JobCrew`, `businessRetainedBp` on the closeout, everything on the snapshot. |
| **Reopening** | An owner unlocks a finalized move **with a written reason**. The existing snapshot is preserved. |
| **Version** | `FinancialSnapshot.version`, unique per closeout, incrementing. |
| **Superseded version** | A snapshot with `supersededAt` set. Retained forever, never edited. |
| **Current version** | The snapshot with `supersededAt = null`. What reports read. |

## Why owner labor counts even when owners take no wage

Because otherwise the business cannot tell a profitable job from an unprofitable
one it survived by working for free.

If Diego and Sebastian each put six hours into a move and draw nothing, the cash
books show zero labor cost and the move looks healthy. Value those twelve hours
at the rate it would cost to hire them, and the same move may be barely
break-even — which is the number that should drive pricing, scheduling and
whether to take work like it again.

So the system records **two** answers and never confuses them:

* **cash gross profit** — what actually happened to the bank balance
* **economic profit** — what would have happened if the owners had been replaced
  by hired labor

Owner economic labor is deliberately kept out of the cash cost, out of payables,
and out of the 30% profit allocation. It is a measurement, not money. An owner is
paid through the allocation; the rate exists so the allocation is calculated on a
profit figure that is honest about what the work cost.
