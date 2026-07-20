# Owner profit splits

A split divides **distributable profit** - never billed revenue, never gross
profit, never an uncollected balance.

| Method | Behavior |
| --- | --- |
| `EQUAL` | halves the distributable amount |
| `OWNERSHIP_PERCENT` | uses configured ownership; **must total 100%** or it is rejected |
| `LABOR_FIRST` | recognizes each owner's unpaid labor first, then splits the remainder by ownership. If labor alone exceeds the amount, labor is paid **pro rata** and nothing is split |
| `CUSTOM` | explicit amounts or percentages; amounts may not exceed distributable, percentages must total 100%; a reason is required |

## Validation

- Allocations can never exceed distributable profit (checked in the calculator
  AND in `canRecordDistribution` AND by a DB CHECK).
- Percentages that do not total 100% are refused with the actual total in the
  message.
- Integer rounding uses **floor**, so parts can never sum above the whole, and
  the remainder is reported as `undistributedCents` rather than quietly handed
  to one owner.
- A loss returns all-zero shares and `ok: true` - that is the answer, not an error.

## Calculating creates nothing

A split is decision support. No money moves and no record is created until an
owner explicitly plans or approves a distribution.
