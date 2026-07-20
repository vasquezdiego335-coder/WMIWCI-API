# Pricing intelligence

Learns ONLY from finalized moves. A provisional move has not proven what it cost.

## Confidence

| Comparables | Confidence | Behavior |
| --- | --- | --- |
| 0-2 | `INSUFFICIENT` | **no price returned at all** |
| 3-5 | `LOW` | range + explicit low-confidence caveat |
| 6-15 | `MODERATE` | range |
| 16+ | `STRONG` | range |

## Method

Comparables are selected by a weighted similarity score (service type, crew size,
duration, stops, city, stairs, heavy items, truck source, out of state) above a
floor, and the matched dimensions are reported.

Outliers are removed with the Tukey 1.5xIQR fence (never below 4 points).
**Median, not mean** — one nightmare move must not reprice twenty normal ones.

The suggested range is the 25th-75th percentile, **floored at the median direct
cost** so the bottom of a recommendation can never lose money.

## Always shown

Assumptions, comparable count, outliers dropped, break-even price, lowest
historically profitable price, and caveats.

## Three break-even floors

```
DIRECT    labor + truck + fuel + tolls + supplies
CASH      direct + overhead                 <- the real company break-even
ECONOMIC  cash + unpaid owner labor value   <- "we did it ourselves" is not free
```

`quoteApplied` is **always false**. Nothing is sent, saved, or applied to a
customer quote; an owner reviews and decides.
