# Template registry

_Last updated 2026-07-20. Supersedes the template table in `EMAIL-REGISTRY.md`._

`P` = promotional (suppression + caps + quiet hours + unsubscribe link).
`T` = transactional (exempt from caps and quiet hours; no unsubscribe link).

Class is decided by `classifyTemplate()` in `src/lib/email-guard.ts`.
**An unlisted template defaults to promotional** — the safer side.

| Template | File | Class | Trigger | Required fields | Stop conditions | Wired? |
|---|---|---|---|---|---|---|
| pre-approval | `pre-approval.tsx` | T | deposit authorized (`fulfillPaidCheckout`) | — | booking deleted | yes (outbox) |
| final-confirmation | `final-confirmation.tsx` | T | owner approves | displayId, date, timeLabel, amountPaid, portalUrl | cancelled | yes (outbox) |
| booking-declined | `booking-declined.tsx` | T | owner denies | — | — | yes |
| payment-receipt | `payment-receipt.tsx` | T | admin resend / capture | displayId, date, amountPaid, portalUrl | — | yes |
| payment-failed | `payment-failed.tsx` | T | auth/capture failure | updatePaymentUrl | — | yes |
| booking-updated | `booking-updated.tsx` | T | reschedule confirmed | portalUrl, ≥1 real change | — | yes (flagged) |
| booking-cancellation | `booking-cancellation.tsx` | T | captured booking cancelled | portalUrl | — | yes |
| job-reminder | `job-reminder.tsx` | T | 72 h / 24 h before move | scheduledStart, timeLabel, originAddress, portalUrl | not CONFIRMED/SCHEDULED; move passed | **scheduler built, not called** |
| job-completion | `job-completion.tsx` | T | booking → COMPLETED | portalUrl | not COMPLETED | yes |
| information-required | `information-required.tsx` | T | details needed | portalUrl | — | yes |
| operational-alert | `operational-alert.tsx` | T | delay / reschedule notice | portalUrl | — | yes |
| final-invoice | `final-invoice.tsx` | T | post-job balance | portalUrl | — | yes |
| abandoned-checkout | `abandoned-checkout.tsx` | P | ~45 min after checkout | checkoutUrl | paid, cancelled, move passed | **yes (new)** |
| abandoned-checkout-2 | same, `stage=2` | P | +24 h | checkoutUrl | as above | **yes (new)** |
| abandoned-checkout-3 | same, `stage=3` | P | +72 h | checkoutUrl | as above | **yes (new)** |
| review-request | `review-request.tsx` | P | completion + 2 h | googleReviewUrl | not COMPLETED | yes |
| review-reminder | same template | P | completion + 48 h | googleReviewUrl | review exists | yes |
| referral | `referral.tsx` | P | completion + 5 d, or positive review + 24 h | referralUrl | **10-rule eligibility gate** | yes |
| referral-reward | `referral-reward.tsx` | P | a referral converted | redeemUrl | program disabled | template only |
| repeat-reminder | inline HTML in `followups.ts` | P | completion + 30 d | — | not COMPLETED | yes |
| quote-followup-1 | `quote-followup.tsx` `stage=1` | P | `quotedAt` + 24 h | bookingUrl | converted, lost, move passed | **built, not called** |
| quote-followup-2 | same, `stage=2` | P | +3 d | bookingUrl | as above | **built, not called** |
| quote-followup-final | same, `stage=3` | P | +7 d | bookingUrl | as above | **built, not called** |

Every template: bilingual EN/ES, plain-text multipart, shared `_ui` kit,
locked palette. Rendering verified by `src/emails/__tests__/client-compat.test.ts`
and `brand.test.ts`; previews in `email-previews/` (22 files).

## Lead drip (separate system)

Leadtracking / SendGrid — `backend/templates/email1..4.html`: welcome + discount,
brand story, urgency, re-engagement. Not governed by this repo's guard; governed
by Leadtracking's own `suppression.js`. See [suppression.md](./suppression.md).

## Known limitations

- `repeat-reminder` still renders **inline HTML**, not the `_ui` kit — it is the
  last template not on the design system. It is also the only one whose colours
  the palette test does not cover (it is not a `.tsx` in `src/emails`).
- `referral-reward` has a template and required fields but **no trigger**: nothing
  detects that a referral converted.
- `quote-followup` cannot restate quote details — no `Quote` model exists.
