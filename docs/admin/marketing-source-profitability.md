# Marketing-source profitability

## The metric

```
Profit ROAS = attributed FINALIZED company net profit / marketing spend
```

Revenue ROAS is shown beside it, deliberately: a campaign can post 22x revenue
ROAS and still be losing money. Only **finalized** profit counts — provisional
profit is reported separately and never credited.

## Reported

Spend - impressions - QR scans - sessions - leads - qualified leads - quotes -
bookings - completed moves - finalized moves - net collected revenue - direct
costs - finalized net profit - average booking value - average profit per move -
cost per lead/quote/booking/completed move - lead-to-quote, quote-to-booking,
booking-to-completed and lead-to-booking conversion - revenue ROAS - profit ROAS -
profit after spend.

## Honest nulls

- No spend -> every cost-per-X and both ROAS values are `null`, never `$0.00` or
  `Infinity`. An organic source has no return on ad spend.
- No finalized move -> `profitable` is `null` with a caveat. Nothing is proven yet.
- Ranking puts **proven** profit first; unproven lead volume sorts last.

## Door-hanger workflow

`MarketingCampaign` carries name, channel, source key, print quantity,
distribution area, creative version, offer, landing page, QR identifier, phone
identifier, dates, budget and status. `MarketingSpend` rows carry print,
distribution, ad spend, platform fee, creative and adjustments — kept as rows so
a correction is an entry, not an overwrite.
