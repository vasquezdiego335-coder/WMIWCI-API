# Estimate versus actual

Compares customer price, duration, crew hours, labor cost, truck cost and direct
expenses. Each line reports estimated, actual, absolute variance, variance in
basis points and a severity.

## Severity

Configurable thresholds (`VarianceThresholds`): notice at 15%, warning at 30%,
target margin 20%.

## Flags

`RAN_LONG` - `CREW_HOURS_OVER` - `TRUCK_COST_OVER` - `EXTRA_STOPS_UNBILLED` -
`STAIRS_UNDERPRICED` - `HEAVY_ITEMS_UNDERPRICED` - `MARGIN_BELOW_TARGET` -
`MOVE_LOST_MONEY` - `QUOTED_HIGH` - `ESTIMATE_FIELDS_MISSING` - `SCOPE_CHANGED`.

## Fairness

**A scope change is not an estimating failure.** More stops, added heavy items or
added stairs set `scopeChanged` and add a `SCOPE_CHANGED` flag listing exactly
what changed, so the owner judges the estimate against the original scope.

A metric with no estimate reads `No estimate recorded` — never a 100% miss. Four
or more missing metrics sets `insufficientEstimate`.

Only finalized moves with a complete estimate and no scope change become pricing
comparables (`isPricingComparable`).
