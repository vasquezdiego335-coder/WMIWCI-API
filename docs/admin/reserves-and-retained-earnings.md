# Reserves and retained earnings

```
company net profit
  - tax reserve
  - business reserves
  - retained earnings
  - unresolved liabilities
  = distributable profit          (floor 0)
```

## Tax reserve

A percentage of **company net profit** (never of gross revenue unless explicitly
configured as a fixed amount), or a fixed amount. **Floored at zero on a loss** -
you do not reserve tax on money you did not make.

**This is an internal estimated reserve, not tax advice.**

## Business reserves

`ReserveAllocation` rows: GENERAL, EMERGENCY, TRUCK_FUND, EQUIPMENT_FUND,
LICENSING_FUND, INSURANCE_FUND, MARKETING_FUND, GROWTH_FUND, RETAINED_EARNINGS,
OTHER. Each carries an amount, a reason, who created it and when.

Total reserves may never exceed company net profit (`canSetReserves`, 422).

## Planned vs actual

Every reserve is a **planned allocation**. `transferred` is false unless a human
confirms real money moved. The UI states this explicitly - the system never
claims a bank balance it cannot see.

## Unresolved liabilities

Unpaid approved crew labor + owner reimbursements owed. Held back automatically
so distributable profit is never money already spoken for.
