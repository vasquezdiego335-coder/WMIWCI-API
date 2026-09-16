# Tracking and attribution

_Last updated 2026-07-20._

## What is recorded

| Event | Where | Notes |
|---|---|---|
| Send attempted | `EmailSend` (status `claimed`) | written **before** the provider call |
| Send succeeded | `EmailSend.status='sent'` + `providerId` + `sentAt` | |
| Send blocked | `EmailSend.status='blocked'` + `blockedReason` | the "why didn't it send?" record |
| Send failed | `EmailSend.status='failed'` + `error` | |
| Delivered / bounced / complained / delayed / opened / clicked | `EmailEvent` | from the Resend webhook, deduped on `providerEventId` |
| Open (first-party pixel) | `Notification.isOpened/openedAt/openCount` | pre-existing |
| Suppression | `EmailSuppression` with reason + source + timestamp | |

`EmailSend` carries `journey`, `campaign`, `bookingId`, `leadId` and `template`,
so per-journey and per-template send/block counts are a single query today.

## What IS built (since this section was first written)

`src/lib/email-attribution.ts` joins the email ledger to bookings and to the
Stage 4 financial records — `attributionByJourney()` and
`emailCampaignResults()`, surfaced on the admin email-marketing pages. It builds
no second attribution system: campaign identity, first/last touch and the
profit-ROAS arithmetic come from `marketing-profitability.ts` and
`FinancialSnapshot`. Three rules keep it honest, and they are worth knowing
before reading any number it produces:

1. **A transactional email never claims a conversion** (a receipt is sent
   *because* a booking happened). Only the `abandoned`, `quote` and `post-job`
   journeys may be credited; everything else reports `null` with a stated
   reason, never `0`.
2. **The email must precede the conversion** — every conversion is time-ordered
   against the send.
3. **Attributed profit comes only from CURRENT `FinancialSnapshot` rows.**
   Completed-but-not-closed-out moves are reported separately.

## What is still NOT built

- click tracking (no redirect route; `EmailEvent type='clicked'` only arrives if
  Resend link-tracking is enabled in the dashboard — unverified)
- discount-code-to-campaign correlation

UTM parameters **are** emitted on quote-journey CTAs
(`utm_source=email&utm_medium=lifecycle&utm_campaign=quote-followup&utm_content=stage-N`),
and `Lead` already has `utmSource/Medium/Campaign/Content/Term` columns populated
at ingestion — so the two ends exist and are simply not joined yet.

## Privacy

- No customer identifier appears in any public URL. The open pixel uses a random
  `openToken`; unsubscribe uses a signed HMAC token that does not contain the
  address in readable form.
- The suppression API requires a shared secret precisely so it cannot be used to
  test whether an address is a customer.

## Reporting limitation you must state to stakeholders

Opens are **not** proof of reading. Gmail and Apple Mail prefetch and proxy
images, inflating opens; clients that block remote images suppress them entirely.
Prioritise clicks, booking activity, and payment activity. **Never report opens
as bookings.**
