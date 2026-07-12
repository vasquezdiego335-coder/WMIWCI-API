# Move It Clear It — Email Registry

The single source of truth for every customer-facing email. **15 active** templates,
one design system (Ink Navy `#0D1A2D` · Bone `#F7F7F2` · Ember Orange `#FF6A00` ·
Antique Gold `#D4A24C`), correct domain `moveitclearit.com`. Everything else is in
[`email-archive/`](./email-archive/) — preserved, not deleted, and wired to nothing.

_Last consolidated: 2026-07-12._

## Active — 15 templates

### Transactional booking emails (React `_ui` kit → `src/emails/`)

| # | Name | Trigger | Recipient | Subject | Source | Status |
|---|------|---------|-----------|---------|--------|--------|
| 1 | Booking received / pre-confirmation | `$49` hold authorized (Stripe checkout → `fulfillPaidCheckout`) | Customer | We've received your booking request | `src/emails/pre-approval.tsx` | **Active** (outbox render) |
| 2 | Booking confirmed | Owner approves in Discord → `$49` captured | Customer | Your booking is approved | `src/emails/final-confirmation.tsx` | **Active** (outbox render) |
| 3 | Booking declined | Owner denies (Discord) or admin cancels a **pre-capture** booking | Customer | About your booking request | `src/emails/booking-declined.tsx` | **Active** |
| 4 | Payment receipt | Admin "Resend receipt" (deposit vs. move total vs. due on move day) | Customer | Payment received — receipt enclosed | `src/emails/payment-receipt.tsx` | **Active** |
| 5 | Booking updated / rescheduled | Reschedule confirmed (`NEW_DATE_PICKED`) — one reusable email | Customer | Your booking has been updated | `src/emails/booking-updated.tsx` | **Active** (gated by `OUTBOX_SEND_DATE_PICKED`) |
| 6 | Booking cancellation | Admin cancels a **captured** booking (`CONFIRMED/SCHEDULED → CANCELLED`) | Customer | Your booking has been cancelled | `src/emails/booking-cancellation.tsx` | **Active** |
| 7 | Move reminder | 72h / 24h before the move (one template, multiple send times) | Customer | Your move is almost here | `src/emails/job-reminder.tsx` | **Template active — scheduler pending** ¹ |
| 8 | Move completed / thank you | Booking marked `COMPLETED` | Customer | Your move is complete — thank you | `src/emails/job-completion.tsx` | **Active** |
| 9 | Review request | +2h after completion (`followups`) | Customer | How did we do? Leave us a review | `src/emails/review-request.tsx` | **Active** |

### Lead & marketing emails

| # | Name | Trigger | Recipient | Subject | Source | Status |
|---|------|---------|-----------|---------|--------|--------|
| 10 | Discount popup welcome | Popup email capture (→ `sendWelcome`, stage 1) | Lead | Welcome to Move It Clear It — your discount is inside | `Leadtracking/backend/templates/email1.html` | **Active** (SendGrid) |
| 11 | Abandoned booking reminder | Started a booking, no deposit | Lead | Your date is still available | `src/emails/abandoned-checkout.tsx` | **Template active — scheduler pending** ¹ |
| 12 | Brand story | Drip stage 2 (~+7d) | Lead | Pay for muscle, not markup | `Leadtracking/backend/templates/email2.html` | **Active** (SendGrid) |
| 13 | Urgency | Drip stage 3 (~+14d) — real schedule scarcity | Lead | Weekends fill up fast — lock in your date | `Leadtracking/backend/templates/email3.html` | **Active** (SendGrid) |
| 14 | Referral | +5d after completion (`followups`) | Customer | Give 15%. Get 15%. | `src/emails/referral.tsx` | **Active** |
| 15 | Re-engagement | Drip stage 4 (~+21d) | Lead | Still planning your move? | `Leadtracking/backend/templates/email4.html` | **Active** (SendGrid) |

¹ **Scheduler pending (fast-follow):** the templates + worker allowlist are ready, but the
jobs that *enqueue* the 72h/24h reminder and the 2h abandoned-checkout recovery are not yet
wired (they need a dedupe-safe daily cron so a booking is never reminded twice). Until then,
these two do not send. Everything else fires on its real event.

## Sending paths (how "exactly one email per event" is guaranteed)

- **Transactional React templates** are sent by the BullMQ **email worker**
  (`src/workers/email.worker.ts`). Its `ALLOWED_TEMPLATES` set is the single choke point —
  the 11 names above are the *only* templates it will send; anything else is dropped with a log.
- **pre-approval / final-confirmation / booking-updated** are rendered by the **outbox**
  (`src/outbox/services/premiumEmails.tsx`) when `OUTBOX_ENABLED=true` (the live setting). The
  legacy queue path is skipped in that mode, so the customer never gets two copies.
- **review-request / referral** are rendered inline by `src/lib/followups.ts` (email + SMS).
- **Lead drip** (10, 12, 13, 15) is sent by **Leadtracking** (Railway + SendGrid),
  `lib/campaign.js` → `templates/emailN.html`.

## Discount codes

| Code | Value | Used by | Where |
|------|-------|---------|-------|
| `MOVE10` (env `DISCOUNT_CODE`) | 10% | New-lead welcome + re-engagement | Leadtracking drip |
| `REFER15` (env `REFERRAL_CODE`) | 15% give / 15% get | Post-move referral | `src/emails/referral.tsx` + `followups` |

## Archived — see `email-archive/`

- **`react-legacy/`** (7): booking-confirmation, booking-confirmed, booking-denied,
  booking-rescheduled, reschedule-offer, pending-approval, contact-ack.
  (booking-denied → replaced by **booking-declined**; reschedule-offer + booking-rescheduled
  → merged into **booking-updated**.)
- **`marketing-library/dist/`** (29): the old numbered `01–22` + `m01–m07` ESP library.
  Its best copy was merged into the 4 Leadtracking marketing emails + the React referral.
- **`leadtracking-original/`** (4): pre-rebrand copies of `email1–4.html`.
