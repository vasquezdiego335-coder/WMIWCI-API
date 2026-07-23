# Triggers and stop rules

_Last updated 2026-07-20._

The rule this document exists to enforce:

> **Deleting a queue record is never the only protection.**
> Every journey stage re-reads the world immediately before the provider call.

There are **three** independent layers. A message must survive all three:

1. **Scheduling** — `src/lib/journeys.ts` refuses to schedule an ineligible sequence.
2. **Dispatch** — `src/workers/scheduled.worker.ts` re-reads the row before enqueueing an email.
3. **Send** — `guardedSend`'s `recheck()` (`stillWantedForBooking` /
   `quoteFollowupBlockReason`) runs immediately before Resend is called.

---

## Journey table

| Journey | Trigger | Stages | Anchor | Class |
|---|---|---|---|---|
| Abandoned booking | booking created, `PENDING_PAYMENT` | ~45 min · 24 h · 72 h | checkout created | promotional |
| Pre-move reminders | move date confirmed | 72 h · 24 h before | move date | **transactional** |
| Post-job follow-ups | booking → `COMPLETED` | 2 h · 48 h · 5 d · 30 d | completion | promotional |
| Quote follow-up | `Lead.quotedAt` set | 24 h · 3 d · 7 d | `quotedAt` | promotional |

All are OFF by default. See [production-rollout.md](./production-rollout.md).

---

## Transition matrix

| Current journey | Event | Required action | Enforced at |
|---|---|---|---|
| Abandoned booking | deposit paid | cancel all remaining stages | `fulfillment.ts` → `onBookingPaid`; **and** dispatch re-reads status; **and** `stillWantedForBooking` |
| Abandoned booking | booking cancelled | stop | dispatch + send-time |
| Abandoned booking | move date passed | stop | dispatch + send-time |
| Abandoned booking | continuation URL unbuildable (`APP_URL` unset) | skip, logged | dispatch |
| Pre-move reminder | booking not `CONFIRMED`/`SCHEDULED` | stop | dispatch + send-time |
| Pre-move reminder | rescheduled | re-anchor (cancel + re-schedule) | `onMoveDateSet` |
| Post-job | booking not `COMPLETED` | stop | `runFollowup` + send-time |
| Post-job review reminder | a review exists | stop | `runFollowup` |
| Referral | any eligibility rule fails | stop | schedule-time **and** send-time |
| Quote follow-up | lead booked / `convertedBookingId` set | stop | `quoteFollowupBlockReason` |
| Quote follow-up | lead lost, or status WON/LOST/BOOKED/CONVERTED | stop | `quoteFollowupBlockReason` |
| Quote follow-up | move date passed | stop | `quoteFollowupBlockReason` |
| Quote follow-up | no `quotedAt` | never schedules | `onQuoteCreated` |
| **Any** | unsubscribe | suppress promotional | `guardedSend` step 2 |
| **Any** | hard bounce | suppress ALL | webhook → `suppress()` |
| **Any** | spam complaint | suppress ALL | webhook → `suppress()` |
| **Any** | internal-test booking | stop | `stillWantedForBooking` |
| **Any** | duplicate trigger | no-op | idempotency key (step 6) |

---

## Referral eligibility

The highest-risk gate, checked **twice** (schedule + send). All ten must hold:

1. booking exists and is `COMPLETED`
2. booking is not an internal test
3. referral program enabled (`REFERRAL_PROGRAM_ENABLED=true`)
4. a Stripe payment exists (unless `REFERRAL_REQUIRE_STRIPE=false`)
5. that payment is `COMPLETED`
6. nothing refunded on it
7. a durable `AuditLog(RECEIPT_SENT)` exists
8. that receipt event is **not in the future**
9. referral URL is a safe absolute https URL, and a code exists
10. address not suppressed; not already sent (ledger + idempotency key)

Implementation: [`src/lib/referral-eligibility.ts`](../../src/lib/referral-eligibility.ts).
Tests: `src/lib/__tests__/referral-eligibility.test.ts` (21 checks, one per
ineligible state).

---

## Frequency and quiet hours

Apply to **promotional** mail only. Transactional booking mail is exempt by
design: a receipt or a move-day reminder must arrive when the event happens.

| Control | Default | Env |
|---|---|---|
| Max promotional / 24 h | 1 | `EMAIL_CAP_PER_DAY` |
| Max promotional / 7 d | 3 | `EMAIL_CAP_PER_WEEK` |
| Max promotional / 30 d | 6 | `EMAIL_CAP_PER_MONTH` |
| Quiet hours (ET) | 21:00 – 08:00 | `EMAIL_QUIET_START_HOUR` / `EMAIL_QUIET_END_HOUR` |
| Gap after a transactional email | 60 min | `EMAIL_TRANSACTIONAL_GAP_MINUTES` |

Quiet-hours and transactional-gap hits are **deferrals**, not blocks: the caller
re-queues with the same idempotency key, so a deferral can never become a
duplicate. Cap hits are blocks and are recorded.

Post-job follow-ups additionally carry their own older caps in
`followups.ts` (≤1/24 h, ≤4/30 d per customer) — the stricter of the two wins.

---

## Trigger wiring (2026-07-21)

Every hardcoded lifecycle journey is now called from a real event site:

| Journey | Fired by |
|---|---|
| Abandoned recovery start | `POST /api/bookings` → `onCheckoutStarted` |
| Abandoned recovery stop (paid) | `fulfillment.ts` → `onBookingPaid` |
| Pre-move reminders (re-)anchor | booking approval (admin status route + Discord `handleApprove`) → `onBookingConfirmed` → `onMoveDateSet`. A customer reschedule sets the booking back to `PENDING_APPROVAL`, so re-approval re-anchors; the stable jobId means the old reminder is replaced, not duplicated. |
| Quote follow-up start | owner records a real quote: `POST /api/admin/email-marketing/leads/[id]/quote` → `markLeadQuoted` (stamps `Lead.quotedAt`) → `onQuoteCreated`. Fires only on the FIRST stamp, so a re-quote cannot restart it. |
| Quote follow-up stop (booked) | `POST /api/bookings` → `markLeadConverted` (stamps `convertedBookingId`/`bookedAt`) → `onLeadClosed` |
| All journeys stop (cancelled) | booking status route → `onBookingCancelled` |

`markLeadConverted` also populates the conversion columns that the audience
builder and attribution already read, so a lead who books now correctly leaves
the `new_leads_no_booking` / `quoted_leads_no_booking` segments.

## Still owner-driven only (BETA, behind the flag)

The **owner-configured campaign and custom-automation dispatch executor** is the
one part not yet built: an owner can create, validate, approve, schedule and
activate a campaign or automation (state machine + audience preview + test send
all work), but nothing yet resolves the audience at the scheduled time and drives
`guardedSend` for each recipient. This is deliberately gated — the overview page
states promotional sending stays disabled behind its flag until a staging
rehearsal passes. Building it safely needs a per-template real-context layer (the
promotional templates carry booking/lead-specific fields), which is why it is a
separate, reviewed build rather than a generic broadcaster.
