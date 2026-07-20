# Company financial reporting

## Metrics

Gross billed revenue - net collected revenue - outstanding balances - refunds -
disputed - direct job costs - labor - truck - other expenses - cash gross profit -
economic profit - allocated overhead - company net profit - economic net profit -
margin - tax reserves - business reserves - retained earnings - owner
reimbursements owed - distributions approved/paid - estimated safe to distribute -
cash shortfall.

All come from `aggregateMoves()` over snapshots, or from the Stage 2 closeout
math for provisional moves. **No page recomputes anything.**

## Periods

today - yesterday - this/previous week - this/previous month - this/previous
quarter - year to date - previous year - custom range.

Boundaries are business-local (`America/New_York`), stored UTC, **exclusive end**.
A move at 8pm on 31 January belongs to January, not February.

## Comparisons

Current vs previous period - actual vs estimate - finalized vs provisional -
cash vs accrual - cash profit vs economic profit.

`compareCents()` returns `changeBp: null` plus the label
`No comparable prior-period value` when the prior period is zero. A percentage
change from zero is never rendered.

## Cash vs accrual

```
CASH    revenue = net COLLECTED     (money that arrived)
ACCRUAL revenue = net BILLED        (earned, settled or not)
```

The difference is the outstanding balance, reported as a receivable and never as
profit or distributable cash.
