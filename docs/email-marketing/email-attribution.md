# Email attribution — did the email make money?

_Last updated 2026-07-21._

Implemented in `src/lib/email-attribution.ts`. Rendered on
`/admin/email-marketing/journeys` and `/admin/email-marketing/campaigns`.

This module builds **no second attribution system**. Campaign identity,
first/last touch and the profit-ROAS arithmetic already live in
`marketing-profitability.ts` and the `FinancialSnapshot` table; this reads them.
It is **read-only** over the financial tables and does not touch profit
allocation, closeout or distribution logic.

## The chain

```
email delivered
  → provider event (delivered / opened / clicked)
  → customer action
  → booking
  → completed move
  → net collected revenue
  → FINALIZED company net profit
```

## The three rules that keep it honest

### 1. A transactional email never claims a conversion

A payment receipt is sent *because* a booking happened. Crediting the booking to
the receipt would make the most reliable transactional templates look like the
best marketing in the business.

Transactional journeys report reach and delivery only. Their conversion figure
is **`null` with a stated reason** — never `0`, which would read as "this
journey produced nothing", a different and false claim.

Only three journeys may claim conversions: `abandoned`, `quote`, `post-job`.
This is asserted by test: any transactional journey that starts claiming
conversions fails `email-registry.test.ts`.

### 2. The email must precede the conversion

A booking already paid before the recovery email went out was not recovered by
it. Every credit is time-ordered against `sentAt`.

### 3. Uncollected revenue is not profit, and provisional profit is not finalized profit

Attributed profit comes only from **current** (`supersededAt: null`)
`FinancialSnapshot` rows. A superseded snapshot is a previous version of the same
move's finances; summing both would double-count.

Moves that completed but are **not** financially closed out are counted and
reported separately, in the caveat column, exactly as
`marketing-profitability.ts` requires.

## Evidence chain per journey

| Journey | What counts as a credit |
|---|---|
| `abandoned` | The booking the email was about **left `PENDING_PAYMENT` after the send**. Stated caveat: this does not prove the email caused the payment. |
| `quote` | The lead's `convertedBookingId`, and only when `bookedAt` is **after** the send. |
| `post-job` | A **later** booking by the same customer, created after the ask — never the move the email was about. |

Internal test bookings (`isInternalTest`) are excluded everywhere. Credits are
deduplicated by booking id, and the **first qualifying send wins**.

## Campaign attribution

An email campaign is a `MarketingCampaign` with `channel = EMAIL`. Its bookings
are found through the **same Stage 3 source fields a door hanger uses** —
`ownerAssignedSource`, `bookingSource`, `utmCampaign`, `source` — so an email
campaign is measured on exactly the same evidence as any other channel.

```
contribution = finalized company net profit − campaign spend
```

**First-touch attribution is never overwritten by this read.** Correcting
attribution remains `marketing.correct_attribution`, owner-only and audited, and
`canCorrectAttribution()` still refuses to overwrite first touch.

## What is deliberately absent

- **Opens and clicks** are reported only when the provider actually sent those
  events. The Overview page says so in the data-completeness note rather than
  rendering a zero that could mean either "nobody opened it" or "tracking is
  off".
- **A `campaignId` foreign key on `EmailSend`.** The ledger carries a `campaign`
  string matched against `sourceKey`. Adding a relation is a reasonable future
  change; it was not needed to answer the owner's questions and would have meant
  a non-additive schema change during a concurrent Stage 4 branch.
- **Multi-touch models.** `resolveAttribution()` supports FIRST_TOUCH,
  LAST_TOUCH and BOOKING; the email pages use booking-level credit and say so.
