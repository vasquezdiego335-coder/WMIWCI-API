# Overhead allocation

Overhead is a **company** cost charged to a move. It is deliberately separate
from direct job costs: `cash gross profit` is before overhead, `company net
profit` is after.

| Method | Calculation |
| --- | --- |
| `NONE` | $0 |
| `PER_MOVE` | a flat cents amount |
| `PCT_REVENUE` | basis points of **net collected revenue** |
| `PER_LABOR_HOUR` | cents x approved crew hours |
| `MONTHLY_POOL` | pool / eligible completed moves (never divides by zero) |
| `MANUAL` | an owner-entered amount, reason required |

## Snapshot behavior

The method **and** the rate are written into the `FinancialSnapshot`
(`overheadMethod`, `overheadRateRaw`). Changing the policy later does not alter
any already-finalized move.

Defaults live on `BusinessConfig`; a move may override them on its closeout.
