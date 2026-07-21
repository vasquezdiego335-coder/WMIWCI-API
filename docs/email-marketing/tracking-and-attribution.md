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

## What is NOT built

**Revenue attribution is not implemented.** Be direct about this: nothing
correlates a click to a booking to a payment. Specifically missing:

- click tracking (no redirect route; `EmailEvent type='clicked'` only arrives if
  Resend link-tracking is enabled in the dashboard — unverified)
- a first-touch / last-touch attribution model
- any join from `EmailSend` → `Booking` → `Payment` revenue
- discount-code-to-campaign correlation
- campaign reporting queries or UI

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
