# Owner labor — cash vs economic

Diego and Sebastian do much of the labor themselves. If that time is recorded as
free, every move looks more profitable than it is, and the business cannot tell
which jobs are worth taking.

## Two figures, always shown separately

```
CASH gross profit = net revenue − cash labor − expenses − fees
ECONOMIC profit   = cash gross profit − unpaid owner labor value
```

- **Cash** answers: how much money did we actually keep?
- **Economic** answers: was this move profitable on its own, or only because the
  owners worked without paying themselves?

## How it is recorded

Assign the owner with pay model **`UNPAID_OWNER`**. Cash cost is $0; the hours are
valued at `BusinessConfig.ownerEconomicRateCents` (default $30/h), snapshot onto
the assignment at assignment time.

An owner who IS paid cash uses a normal pay model — their labor is a real cash
cost and carries no subsidy.

Worked example (staging Scenario 2): $2,000 revenue, $410 expenses, helper paid
$300, owner works 10h unpaid → **cash gross profit $1,290**, **economic profit
$990**. The owner personally subsidized $300.

## Classification rules

- An owner **draw** is not labor pay. It stays an `OwnerTransaction` (WITHDRAWAL).
- An owner **reimbursement** is not labor pay. It stays an `OwnerTransaction`
  (REIMBURSEMENT) and is held back from distributable cash.
- Only an OWNER may set the economic rate (`labor.set_owner_labor_value`).

## Not built in Phase 1

Paying an owner *for labor* as a distinct `OwnerTransaction` type
(`LABOR_PAYMENT`) is not implemented; today an owner paid for labor is recorded
like any other paid worker. Adding that type is the clean follow-up so labor
payments never contaminate the draw ledger.
