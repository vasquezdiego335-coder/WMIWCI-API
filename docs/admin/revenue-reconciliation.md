# Revenue reconciliation

## Billed vs collected

```
net billed revenue    = gross customer charges - discounts - credits
net collected revenue = captured - actual refunds - lost chargebacks
outstanding balance   = net billed - net collected - write-off   (floor 0)
```

**Only collected money reaches profit.** Failed, declined, uncaptured
authorizations, open invoices and estimated future payments are never cash.

## Refunds and disputes

Refunds net off **revenue** (Phase 0) using `Payment.refundedAmountCents` and are
never a second cost line. A **lost** dispute removes the money; an **open**
dispute is reported as at-risk, blocks finalization until acknowledged, and is
held back from distributable cash. A partial refund with no recorded amount is a
HARD blocker - the amount is never guessed.

## Discrepancies the panel surfaces

Billed differs from collected (outstanding balance) - a refund with no amount -
money in an open dispute - a completed move with no captured payment at all.

## Manual payments

Cash / Zelle / Venmo / check money enters through the audited manual payment
route (Phase 0). No admin action can fabricate a Stripe state.
