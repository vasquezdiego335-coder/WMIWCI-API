# The email lifecycle matrix

_Owner spec 2026-08-06. This is the answer to "who gets which email, and why
not?" — one table per question, and every cell maps to a named block reason a
gate actually returns._

Companion documents: [triggers-and-stop-rules.md](./triggers-and-stop-rules.md)
(the transition matrix), [suppression.md](./suppression.md) (the do-not-send
list), [customer-journeys.md](./customer-journeys.md) (the copy).

---

## 0. The one rule everything else is arranged around

A **promotional** email may leave this system only when
`emailMarketingConsent === true`.

`false` and `null` both refuse, and they are **not the same fact**: `false`
means we asked and they declined, `null` means the question was never put to
them. Collapsing them destroys information we cannot get back, so the schema
keeps three states and every gate refuses two of them.

Holding somebody's email address is not consent. Submitting a form is not
consent. Consent is an unchecked checkbox that a person ticked, recorded with
its **source**, its **disclosure version**, and its **timestamp**.

Which emails are promotional is decided in exactly one place —
`email-guard.classifyTemplate` — and an unregistered template defaults to
**promotional**, because that is the direction where a mistake is harmless
(caps, quiet hours, an unsubscribe link) rather than a complaint.

---

## 1. Lead sources, and what each one may do

| Source | Endpoint | Email required | Consent control | Immediate email | Sequence when consent is `true` | When consent is `false`/`null` |
|---|---|---|---|---|---|---|
| Quick quote (priced) | `POST /api/leads/quote-capture` | yes | unchecked box on `quote.html` | `quote-request-received` (transactional) | **A** — quote follow-up 24h / 3d / 7d | confirmation only |
| Quick quote (in-person or 5BR+/"not sure") | same | yes | same | `quote-request-received`, no number | **B** — lead nurture 4h / 24h / 72h | confirmation only |
| Contact form | `POST /api/contact` | yes | unchecked box on `contact.html` **(new)** | none (Discord alert to the owner) | **B** | nothing |
| Booking form Step 1 (partial) | `POST /api/leads/partial` | no | unchecked box on `booking-form.html` | none — silent by design | none directly; the booking journey owns them | nothing |
| Marketing tracker | `POST /api/notify/lead` | no | accepted via `marketing_consent` **(new)** | `lead-acknowledgement` (transactional, flag-gated) | **B** | acknowledgement only |
| Coupon / popup | Leadtracking (separate repo, SendGrid) | yes | its own capture | its own | its own drip | — |
| Admin-created lead | admin UI | no | `ADMIN_MANUAL` source | none | A, once a quote is marked | nothing |
| Booking (checkout started) | `POST /api/bookings` | yes | carried from the booking form | `pre-approval` (transactional) | abandoned-checkout 45m / 24h / 72h | **nothing** — the recovery sequence is promotional |

**Never inferred:** a source that omits `marketingConsent` entirely leaves the
stored value untouched. A cached page that predates the checkbox therefore keeps
working and keeps writing nothing.

---

## 2. Consent × customer state → what sends

`T` = transactional (permitted), `P` = promotional (permitted),
`—` = nothing, and the parenthesised value is the **block reason recorded on the
`EmailSend` row**.

| Customer state | consent `true` | consent `false` | consent `null` | Unsubscribed | Hard bounce / complaint |
|---|---|---|---|---|---|
| New lead, no quote | T + P (Sequence B) | T only (`no_marketing_consent`) | T only (`no_marketing_consent`) | T only (`unsubscribed`) | — (`hard_bounce`, scope `all`) |
| Quote requested, no number | T + P (Sequence B) | T only | T only | T only | — |
| Quote provided | T + P (Sequence A) | T only | T only | T only | — |
| Booking started, unpaid | T + P (abandoned recovery) | T only | T only | T only | — |
| Booked / confirmed | T (confirmation, receipts, **move reminders**) | same | same | **same** | — |
| Declined by us | T (`booking-declined`) | same | same | same | — |
| Cancelled by customer | T (`booking-cancellation`) | same | same | same | — |
| Move completed | T (`job-completion`) + P (review, referral, repeat) | T only | T only | T only | — |
| Move date passed, never booked | — (`move_date_passed`) | — | — | — | — |
| Previously booked, enquires again | T + P **except** Sequence B (`previous_customer`) | T only | T only | T only | — |
| No email on record | — (`no_email`) | — | — | — | — |

The row that matters most is **Booked / confirmed**: an unsubscribe stops the
offers and **does not** stop the move-day details. That is the entire reason the
suppression list has two scopes (`promotional` and `all`) rather than one flag.
Those operational messages must stay operational — the pre-move journey is
classified transactional, carries no unsubscribe link, and contains no offer.

---

## 3. Block reasons, and what each one means

Every refusal is recorded on `EmailSend.blockedReason` with a class
(`terminal` / `retryable` / `deferred`) so a temporary condition never silently
becomes permanent.

| Reason | Class | Meaning |
|---|---|---|
| `no_marketing_consent` | retryable | Never opted in, or explicitly declined. A later opt-in can rescue the send. |
| `marketing_opted_out` | terminal | Texted STOP. An explicit withdrawal. |
| `unsubscribed` | terminal | Clicked the unsubscribe link. |
| `hard_bounce`, `spam_complaint`, `invalid_address`, `provider_rejected`, `admin_block` | terminal | Suppression, scope `all` — even transactional stops. |
| `lead_converted`, `lead_lost`, `lead_status:<X>` | terminal | The lead closed. |
| `previous_customer` | terminal | Booking history exists; the first-time sequence does not apply. |
| `has_quote` | terminal | A real quote exists — Sequence A owns them, not B. |
| `no_quote` | retryable | Sequence A refuses a lead with no `quotedAt`. |
| `no_email`, `blank_email`, `invalid_email` | terminal | Nobody to write to. |
| `move_date_passed` | terminal | Nothing left to sell or remind about. |
| `deposit_already_paid` | terminal | Recovery mail is no longer truthful. |
| `not_completed` | retryable | Post-move mail before the job finished. |
| `status_not_allowed:<STATUS>` | terminal | The template's claim is untrue in this booking state. |
| `internal_test_booking` | terminal | A rehearsal record never generates customer mail. |
| `duplicate` | terminal | This exact business event already delivered. |
| `quiet_hours`, `cap_daily`, `cap_weekly`, `cap_monthly`, `transactional_gap` | deferred | Not now — `nextAttemptAt` says when. |
| `email_sending_disabled` | deferred | Global kill switch; every held send resumes when it is flipped back. |
| `missing-configuration:marketing-context:…` | retryable | The unsubscribe link or postal address is unconfigured. Blocked rather than sent non-compliant. |
| `suppression_read_failed`, `eligibility_read_failed`, `consent_read_failed`, `state_read_failed` | retryable | We could not verify; failed closed. |

---

## 4. The sequences

Delays live in code — `journeys.QUOTE_STAGES`, `LEAD_NURTURE_STAGES`,
`ABANDONED_STAGES`, `REMINDER_OFFSETS`, `followups.COMPLETION_DELAYS` — and the
admin's journey config can adjust them within validated bounds
(`email-journey-config.ts`). The registry imports the constants rather than
restating them, so the admin timeline cannot show a schedule nobody runs.

### A · Quote follow-up (promotional) — anchor `Lead.quotedAt`

| When | Template | Purpose |
|---|---|---|
| immediate | `quote-request-received` (**transactional**) | The estimate itself, from the **stored** number. |
| +24h | `quote-followup-1` | Did it arrive? One question answered. |
| +3d | `quote-followup-2` | What "labor-only" actually means. |
| +7d | `quote-followup-final` | Still moving? Permission to say no. Sequence ends. |

**Three stages, not five.** The owner spec sketches a five-touch cadence; this
system already had a deliberate three-message sequence, the spec says to
preserve three unless there is a documented reason not to, and the frequency
caps (1/day, 3/week) would drop a fourth and fifth anyway. The spec's *purposes*
are mapped onto the three that exist: the "quote reminder" is stage 1, "trust
and about us" is stage 2, and "final check-in" is stage 3. The **availability
reminder is deliberately omitted** — it would require a truthful capacity claim,
and nothing in this system checks live availability at send time.

**New in this pass:** a quick quote that produces a real server-priced number now
stamps `Lead.quotedAt` and starts this sequence. Before, `quotedAt` was written
only by the admin's "mark quoted" button, so the one surface guaranteed to have
a genuine quote was the one surface excluded from the quote journey.

### B · Non-quote lead nurture (promotional) — anchor: lead captured

| When | Template | Purpose |
|---|---|---|
| +4h | `lead-nurture-1` | What we need in order to price it accurately. |
| +24h | `lead-nurture-2` | What labor-only actually means. |
| +72h | `lead-nurture-final` | Do you still need an estimate? Sequence ends. |

Refuses itself for: no consent, `has_quote`, `previous_customer`, converted,
lost, move date passed. The template **cannot** mention a price or a checkout —
there is a test that reads the file and fails if a dollar figure, a price prop,
"finish your booking", or an invented scarcity phrase appears in it.

### C · Booking and move reminders (transactional)

| When | Template |
|---|---|
| checkout | `pre-approval` |
| approval | `final-confirmation` |
| 72h before | `job-reminder` |
| 24h before | `job-reminder` |
| changes | `booking-updated` · `booking-cancellation` · `payment-receipt` · `payment-failed` |

Re-anchored on every reschedule; a window already in the past is skipped rather
than fired late. Not sent when the booking is cancelled, the move is complete,
the date is missing or gone, or the address is suppressed at scope `all`.

### D · Post-move review (promotional)

`review-request` at +2h, `review-reminder` at +48h (skipped once a review
exists). **Classification decision, stated for the record:** these stay
promotional. Their purpose is to generate a public review that brings in more
business — that is marketing, whatever the timing suggests — so they require
`emailMarketingConsent === true`, carry an unsubscribe link, and respect the
caps. They are *not* reclassified as transactional to make them easier to send.

Triggered only by an explicit `COMPLETED` transition, never by a date passing.

### E · Past-customer referral and rebooking (promotional)

`referral` at +5d (or +24h after a positive review — one ledger key, so only one
is ever sent), `repeat-reminder` at +30d. Requires consent, a completed booking,
and referral eligibility (payment settled, not refunded, program enabled). The
referral offer is a **real configured code**; nothing invents a discount.

---

## 5. Consent merge rules

When the same address arrives through more than one form:

| Existing | Submitted | Result |
|---|---|---|
| anything | (field absent) | unchanged — silence is not a decision |
| `null` | `true` | `true`, with source + version + timestamp |
| `null` | `false` | `false` — we asked, they declined |
| `false` | `true` | `true` — an explicit later opt-in |
| `true` | `false` | **`true`** — an unchecked box on a later form is not an unsubscribe |
| `true` | `true` | unchanged — the ORIGINAL timestamp is preserved |
| suppressed | anything | unchanged — a form can never re-subscribe |

Re-subscription requires the unsubscribe page's own "keep me subscribed" action,
and a hard suppression (bounce or complaint) is never lifted that way at all.

The rules are one pure function, `consent.decideConsent`, called by every write
path: `leads.buildLeadUpdate` (contact / coupon / tracker),
`leads.markLeadConverted` (booking), and the partial-capture path.

---

## 6. Where each gate lives

| Gate | Module | Runs at |
|---|---|---|
| `decideConsent` | `lib/consent.ts` | every consent write |
| `hasPromotionalConsent` | `lib/leads.ts` | the tested definition of "may we market" |
| `hasEverBooked` / `countsAsPriorBooking` | `lib/leads.ts` | nurture scheduling + send |
| `quoteFollowupBlockReason` | `lib/journeys.ts` | Sequence A, schedule + send |
| `leadNurtureBlockReason` | `lib/journeys.ts` | Sequence B, schedule + send |
| `transactionalLeadBlockReason` | `lib/journeys.ts` | the immediate quote reply |
| `promotionalConsentBlockReason` | `lib/email-eligibility.ts` | every booking-scoped promotional send |
| `bookingBlockReason` / `bookingEligibility` | `lib/email-eligibility.ts` | send time, reloading the booking |
| `bookingMarketingBlockReason` | `lib/email-eligibility.ts` | schedule time |
| `isSuppressed` | `lib/email-suppression.ts` | inside `guardedSend`, fails closed |
| `guardedSend` | `lib/email-guard.ts` | the only door out |

**Every promotional send is checked twice** — once when it is scheduled, so
doomed jobs never occupy the queue and the reason is logged at the moment the
owner acts, and once immediately before the provider call, because a lead can
book, decline, unsubscribe or bounce in between. The schedule-time check is a
convenience; the send-time check is the guarantee.
