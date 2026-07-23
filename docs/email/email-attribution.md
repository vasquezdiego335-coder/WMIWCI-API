# Email attribution

_Last updated 2026-07-21._ Source: `src/lib/email-attribution.ts`.

Full detail, unchanged and not duplicated here:
[../email-marketing/email-attribution.md](../email-marketing/email-attribution.md).

## The chain

```
email delivered → provider event → customer action → booking
  → completed move → net collected revenue → FINALIZED company net profit
```

## The four rules

1. **A transactional email never claims a conversion.** Its figure is `null`
   with a stated reason, never `0`. Only `abandoned`, `quote` and `post-job` may
   claim conversions; a test enforces it.
2. **The email must precede the conversion.** Time-ordered against `sentAt`.
3. **Only current, non-superseded `FinancialSnapshot` rows count.** Completed
   but un-finalized moves are reported separately in the caveat column.
4. **Test sends are excluded** from every figure (`isTest: false` everywhere).

## The direct campaign relation (added 2026-07-21)

`EmailSend.campaignId` → `MarketingCampaign`, nullable, indexed,
**`onDelete: SetNull`**. Deleting or archiving a campaign must never destroy the
record that an email was sent to a real person.

`EmailSend.campaign` (the legacy source-key string) is kept. New campaign sends
populate both. Reporting **prefers the relation and falls back to the string**:

```ts
OR: [{ campaignId: c.id }, { campaignId: null, campaign: c.sourceKey }]
```

**Historical rows were deliberately NOT backfilled.** A source-key match is not
proof of which campaign sent an email, and two campaigns can share a source key
over time. Guessing would fabricate attribution that the reports then present as
fact. Ambiguous rows stay `NULL` and fall back to the string, which is honest
about being a string. A test asserts the migration contains no backfill `UPDATE`.

First-touch attribution is never overwritten by any of this.
